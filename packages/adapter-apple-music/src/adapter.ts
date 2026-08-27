import { defaultCapabilities, similarity } from 'upnext-core';
import type {
  Adapter,
  AdapterReading,
  Binding,
  Capabilities,
  MediaRef,
} from 'upnext-core';
import {
  PAUSE_SCRIPT,
  RESUME_SCRIPT,
  STATE_SCRIPT,
  isInstalled,
  playScript,
  runAppleScript,
  searchScript,
  seekScript,
  volumeScript,
  type ScriptRunner,
} from './applescript.js';
import { hasEnded, parseSearchResults, parseState, persistentIdFrom, trackUri } from './parse.js';

export interface AppleMusicAdapterOptions {
  id?: string;
  /** Injected for tests, and for a host that would rather run scripts itself. */
  run?: ScriptRunner;
  /**
   * Minimum confidence that a library hit is the track that was asked for.
   * Below this, the entry falls through to another source instead of playing
   * something that merely shares a word with it.
   */
  matchThreshold?: number;
}

/**
 * The Music app on macOS.
 *
 * Worth having as its own adapter rather than a second copy of the Spotify one,
 * for a single reason: **its dictionary can search.** Spotify's plays a URI you
 * hand it but cannot look anything up, so on a Mac with no token and no indexed
 * music folder, nothing could turn `{ title: 'Bad Habit' }` into something
 * playable. This can — with no credentials, no account registration and nothing
 * to install beyond an app that ships with the system.
 *
 * It searches the *library*, not the catalogue. What it can play is what the
 * person actually has, which is the honest boundary and the one worth stating.
 */
export class AppleMusicAdapter implements Adapter {
  readonly id: string;

  readonly capabilities: Capabilities = {
    ...defaultCapabilities,
    // No notifications from the app; the runtime samples it.
    endOfTrack: 'poll',
    // `player position` is the app's own playhead, not a clock of ours.
    position: 'authoritative',
    seek: true,
    pause: true,
    volume: true,
    // The differentiator, and the reason this package exists.
    search: true,
    // Somebody can hit next in the app, or on their keyboard, at any moment.
    externalControl: true,
  };

  #run: ScriptRunner;
  #threshold: number;
  #binding: Binding | null = null;

  constructor(options: AppleMusicAdapterOptions = {}) {
    this.id = options.id ?? 'apple-music';
    this.#run = options.run ?? runAppleScript;
    this.#threshold = options.matchThreshold ?? 0.55;
  }

  async init(): Promise<void> {
    if (!(await isInstalled(this.#run))) {
      throw new Error('the Music app is not available here — this adapter needs macOS');
    }
  }

  match(ref: MediaRef): number {
    if (ref.uri) return persistentIdFrom(ref.uri) ? 1 : 0;
    // A title it can look up. Below a source holding the actual link, above one
    // that would have to guess.
    return ref.title ? 0.5 : 0;
  }

  async resolve(ref: MediaRef): Promise<Binding | null> {
    const direct = ref.uri ? persistentIdFrom(ref.uri) : null;
    if (direct) {
      return { adapterId: this.id, nativeUri: trackUri(direct), ref: { ...ref } };
    }
    if (!ref.title) return null;

    const query = [ref.title, ref.artist].filter(Boolean).join(' ');
    const hits = parseSearchResults(await this.#run(searchScript(query, 10)));
    if (hits.length === 0) return null;

    // Checked here as well as in the runtime, because the runtime compares what
    // came back against what was asked for — and a library search happily
    // returns a track that merely shares a word.
    const best = hits
      .map((hit) => ({ hit, score: similarity(ref, hit) }))
      .sort((a, b) => b.score - a.score)[0]!;
    if (best.score < this.#threshold) return null;

    return {
      adapterId: this.id,
      nativeUri: best.hit.uri!,
      ref: { ...ref, ...best.hit },
    };
  }

  async search(query: string, limit = 10): Promise<MediaRef[]> {
    return parseSearchResults(await this.#run(searchScript(query, limit)));
  }

  async load(binding: Binding): Promise<void> {
    this.#binding = binding;
  }

  async play(): Promise<void> {
    const id = this.#binding ? persistentIdFrom(this.#binding.nativeUri) : null;
    // With nothing loaded this is a resume, which is what `play()` means when
    // the runtime is picking up where a pause left off.
    await this.#run(id ? playScript(id) : RESUME_SCRIPT);
  }

  async pause(): Promise<void> {
    await this.#run(PAUSE_SCRIPT);
  }

  /**
   * Pause, never quit.
   *
   * The queue moving on to a podcast is not a reason to close somebody's music
   * app, and the dictionary's `stop` would drop their place in the track.
   */
  async stop(): Promise<void> {
    await this.#run(PAUSE_SCRIPT);
    this.#binding = null;
  }

  async seek(positionMs: number): Promise<void> {
    await this.#run(seekScript(positionMs / 1000));
  }

  async setVolume(volume: number): Promise<void> {
    await this.#run(volumeScript(volume));
  }

  async poll(): Promise<AdapterReading> {
    const reading = parseState(await this.#run(STATE_SCRIPT));

    // Not running, or nothing loaded. Either way there is nothing of ours here.
    if (!reading) return { status: 'idle', nativeUri: null };

    return {
      status: hasEnded(reading) ? 'ended' : reading.status,
      positionMs: reading.positionMs,
      durationMs: reading.durationMs,
      // Changes when the track does, which is how a person hitting next in the
      // app becomes something the runtime can notice and adopt.
      nativeUri: reading.persistentId ? trackUri(reading.persistentId) : null,
    };
  }
}
