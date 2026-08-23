import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultCapabilities } from 'upnext-core';
import type {
  Adapter,
  AdapterEvent,
  Binding,
  Capabilities,
  MediaRef,
} from 'upnext-core';
import { Library, isAudioPath } from './library.js';
import { detectPlayer, probeDurationMs, type PlayerSpec } from './players.js';

export { Library } from './library.js';
export { detectPlayer, PLAYERS } from './players.js';

export interface LocalAdapterOptions {
  id?: string;
  /** Directories indexed at init so `search` and `match` can work by title. */
  library?: string[];
  /** Preference order of player binaries. */
  players?: string[];
  /** Skip the ffprobe call that fills in durations. */
  probeDurations?: boolean;
}

/**
 * Plays audio files by handing them to a command-line player.
 *
 * This is the reference backend: no credentials, no accounts, no network. It is
 * what makes the library demonstrable with nothing installed, and it sits at
 * the fully-controlled end of the capability spectrum — the process is ours, so
 * its exit *is* the end-of-track event, with no polling and no guessing.
 */
export class LocalAdapter implements Adapter {
  readonly id: string;

  #capabilities: Capabilities;
  #options: LocalAdapterOptions;
  #library = new Library();
  #player: PlayerSpec | null = null;

  #binding: Binding | null = null;
  #child: ChildProcess | null = null;
  #listeners = new Set<(event: AdapterEvent) => void>();
  /** Set while we are deliberately killing the process, so exit is not "ended". */
  #stopping = false;
  #startOffsetMs = 0;
  #paused = false;

  constructor(options: LocalAdapterOptions = {}) {
    this.id = options.id ?? 'local';
    this.#options = options;
    // Assume the weaker player until init() finds out what is actually here.
    this.#capabilities = {
      ...defaultCapabilities,
      endOfTrack: 'event',
      position: 'estimated',
      pause: true,
      search: (options.library?.length ?? 0) > 0,
    };
  }

  get capabilities(): Capabilities {
    return this.#capabilities;
  }

  async init(): Promise<void> {
    this.#player = await detectPlayer(this.#options.players);
    if (!this.#player) {
      throw new Error(
        'no supported audio player found — install ffmpeg (ffplay) or run on macOS (afplay)',
      );
    }
    // Capabilities are discovered, not declared: what this adapter can do
    // depends on which binary happens to be installed.
    this.#capabilities = { ...this.#capabilities, seek: this.#player.canSeek };
    if (this.#options.library?.length) await this.#library.scan(this.#options.library);
  }

  match(ref: MediaRef): number {
    const uri = ref.uri;
    if (uri) {
      if (uri.startsWith('file://') || uri.startsWith('/') || uri.startsWith('./')) {
        return isAudioPath(uri) ? 1 : 0.6;
      }
      if (/^https?:/.test(uri)) {
        if (!this.#player?.canStream) return 0;
        return isAudioPath(uri) ? 0.8 : 0;
      }
      return 0; // spotify:, applemusic: and friends are somebody else's job.
    }
    return this.#library.has(ref.title) ? 0.4 : 0;
  }

  async resolve(ref: MediaRef): Promise<Binding | null> {
    const target = ref.uri ? toLocalTarget(ref.uri) : this.#fromLibrary(ref.title);
    if (!target) return null;

    const durationMs =
      ref.durationMs ??
      (this.#options.probeDurations === false ? null : await probeDurationMs(target));

    return {
      adapterId: this.id,
      nativeUri: target,
      ref: {
        ...ref,
        uri: ref.uri ?? target,
        title: ref.title ?? basenameOf(target),
        ...(durationMs ? { durationMs } : {}),
      },
    };
  }

  async search(query: string, limit = 10): Promise<MediaRef[]> {
    return this.#library.search(query, limit);
  }

  async load(binding: Binding, opts?: { startAtMs?: number }): Promise<void> {
    await this.stop();
    this.#binding = binding;
    this.#startOffsetMs = opts?.startAtMs ?? 0;
  }

  async play(): Promise<void> {
    if (this.#child && this.#paused) {
      this.#child.kill('SIGCONT');
      this.#paused = false;
      return;
    }
    if (this.#child) return;
    this.#spawn();
  }

  async pause(): Promise<void> {
    if (!this.#child || this.#paused) return;
    // SIGSTOP freezes the player mid-buffer. Crude, but it is genuinely a
    // pause rather than a stop-and-restart, which is what matters.
    this.#child.kill('SIGSTOP');
    this.#paused = true;
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    this.#child = null;
    // A SIGSTOPped process cannot act on SIGKILL until it is resumed.
    if (this.#paused) child.kill('SIGCONT');
    this.#paused = false;
    child.kill('SIGKILL');
    this.#stopping = false;
  }

  async seek(positionMs: number): Promise<void> {
    if (!this.#player?.canSeek || !this.#binding) {
      throw new Error(`${this.id}: ${this.#player?.bin ?? 'player'} cannot seek`);
    }
    // No IPC to speak of, so seeking means relaunching at an offset.
    const binding = this.#binding;
    await this.stop();
    this.#binding = binding;
    this.#startOffsetMs = positionMs;
    this.#spawn();
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.#listeners.clear();
  }

  #spawn(): void {
    if (!this.#player || !this.#binding) return;
    const args = this.#player.args(this.#binding.nativeUri, this.#startOffsetMs);
    const child = spawn(this.#player.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.#child = child;
    this.#paused = false;

    child.on('error', (err) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#emit({ type: 'error', code: 'spawn_failed', message: err.message });
    });

    child.on('exit', (code, signal) => {
      if (this.#child !== child) return; // Superseded by a newer spawn.
      this.#child = null;
      if (this.#stopping || signal === 'SIGKILL') return;
      if (code === 0) this.#emit({ type: 'ended' });
      else {
        this.#emit({
          type: 'error',
          code: 'player_failed',
          message: `${this.#player?.bin} exited with code ${code}`,
        });
      }
    });
  }

  #fromLibrary(title: string | undefined): string | null {
    if (!title) return null;
    const hit = this.#library.search(title, 1)[0];
    return hit?.uri ? toLocalTarget(hit.uri) : null;
  }

  #emit(event: AdapterEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

/** Command-line players want a path, not a file:// URL. */
function toLocalTarget(uri: string): string {
  if (uri.startsWith('file://')) return fileURLToPath(uri);
  return uri;
}

function basenameOf(target: string): string {
  const name = target.split('/').pop() ?? target;
  return name.replace(/\.[^.]+$/, '');
}
