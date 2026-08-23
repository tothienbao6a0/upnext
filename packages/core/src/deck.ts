import { AQError, ErrorCodes } from './errors.js';
import type { Scheduler } from './scheduler.js';
import { Watcher } from './watcher.js';
import { idlePlayback } from './types/index.js';
import type {
  Adapter,
  AdapterEvent,
  Binding,
  MediaRef,
  PlaybackState,
  PlaybackStatus,
  SerializedError,
} from './types/index.js';

export interface DeckHandlers {
  onEnded(): void;
  onExternal(nativeUri: string | null, ref?: MediaRef): void;
  onError(error: SerializedError): void;
  onPlaybackChanged(state: PlaybackState): void;
  onPosition(itemId: string, positionMs: number, durationMs: number | null): void;
}

export interface DeckOptions {
  scheduler: Scheduler;
  pollIntervalMs: number;
  positionIntervalMs: number;
}

/**
 * The one thing currently loaded, and the controls that act on it.
 *
 * Everything here is about a single item: which backend holds it, where the
 * playhead is, and whether the transport verb being asked for is something this
 * particular backend can actually do. The runtime above deals in queues and
 * ordering and never touches a `Watcher` directly.
 */
export class Deck {
  #playback: PlaybackState = { ...idlePlayback };
  #watcher: Watcher | null = null;
  #handlers: DeckHandlers;
  #opts: DeckOptions;

  constructor(handlers: DeckHandlers, opts: DeckOptions) {
    this.#handlers = handlers;
    this.#opts = opts;
  }

  get state(): PlaybackState {
    return { ...this.#playback };
  }

  get status(): PlaybackStatus {
    return this.#playback.status;
  }

  get itemId(): string | null {
    return this.#playback.itemId;
  }

  get adapter(): Adapter | null {
    return this.#watcher?.adapter ?? null;
  }

  get binding(): Binding | null {
    return this.#watcher?.binding ?? null;
  }

  get loaded(): boolean {
    return this.#watcher !== null;
  }

  /** Take over a backend that is already playing `binding`, and start watching. */
  attach(itemId: string, adapter: Adapter, binding: Binding): void {
    this.#watcher = new Watcher(adapter, binding, this.#watcherHandlers(), this.#opts);
    this.#watcher.start();
    this.patch({
      status: 'playing',
      itemId,
      adapterId: adapter.id,
      positionMs: 0,
      durationMs: binding.ref.durationMs ?? null,
      positionSource: adapter.capabilities.position,
    });
  }

  /** Stop watching and hand back the adapter that was in use, if any. */
  detach(): Adapter | null {
    if (!this.#watcher) return null;
    const adapter = this.#watcher.adapter;
    this.#watcher.stop();
    this.#watcher = null;
    return adapter;
  }

  /** Back to nothing loaded, landing on one final status. Volume persists. */
  reset(status: PlaybackStatus): void {
    this.#playback = { ...idlePlayback, status, volume: this.#playback.volume };
    this.#handlers.onPlaybackChanged(this.state);
  }

  /** Apply a partial update, announcing it only if something actually changed. */
  patch(partial: Partial<PlaybackState>): void {
    const next = { ...this.#playback, ...partial };
    const changed = (Object.keys(partial) as Array<keyof PlaybackState>).some(
      (key) => this.#playback[key] !== next[key],
    );
    this.#playback = next;
    if (changed) this.#handlers.onPlaybackChanged(this.state);
  }

  /** Route a backend event. Returns false if it came from a backend we are not on. */
  handleEvent(adapter: Adapter, event: AdapterEvent): boolean {
    if (!this.#watcher || this.#watcher.adapter.id !== adapter.id) return false;
    this.#watcher.handleEvent(event);
    return true;
  }

  // -- transport ------------------------------------------------------------

  async pause(): Promise<void> {
    const watcher = this.#require('pause');
    if (this.#playback.status !== 'playing') return;
    await watcher.adapter.pause!();
    watcher.pause();
    this.patch({ status: 'paused', positionMs: watcher.positionMs });
  }

  async resume(): Promise<void> {
    const watcher = this.#watcher;
    if (!watcher || this.#playback.status !== 'paused') return;
    await watcher.adapter.play();
    watcher.resume();
    this.patch({ status: 'playing' });
  }

  async seek(positionMs: number): Promise<void> {
    const watcher = this.#require('seek');
    const clamped = Math.max(0, Math.round(positionMs));
    await watcher.adapter.seek!(clamped);
    watcher.reanchor(clamped);
    this.patch({ positionMs: clamped });
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = Math.min(1, Math.max(0, volume));
    // With nothing loaded, remember the level for whatever plays next.
    if (!this.#watcher) return this.patch({ volume: clamped });
    const watcher = this.#require('volume');
    await watcher.adapter.setVolume!(clamped);
    this.patch({ volume: clamped });
  }

  /**
   * A backend that cannot do something says so rather than failing silently or
   * faking it — an agent that asked to seek needs to know it did not happen.
   */
  #require(capability: 'pause' | 'seek' | 'volume'): Watcher {
    const watcher = this.#watcher;
    if (!watcher) throw new AQError(ErrorCodes.NotFound, 'nothing is loaded');
    const method = capability === 'volume' ? 'setVolume' : capability;
    if (!watcher.adapter.capabilities[capability] || !watcher.adapter[method]) {
      throw new AQError(
        ErrorCodes.Unsupported,
        `adapter ${watcher.adapter.id} cannot ${capability === 'volume' ? 'set volume' : capability}`,
        watcher.adapter.id,
      );
    }
    return watcher;
  }

  #watcherHandlers() {
    return {
      onEnded: () => this.#handlers.onEnded(),
      onExternal: (nativeUri: string | null, ref?: MediaRef) =>
        this.#handlers.onExternal(nativeUri, ref),
      onError: (error: SerializedError) => this.#handlers.onError(error),
      onStatus: (status: PlaybackStatus) => this.patch({ status }),
      onPosition: (positionMs: number, durationMs?: number) => {
        this.patch({ positionMs, ...(durationMs ? { durationMs } : {}) });
        if (this.#playback.itemId) {
          this.#handlers.onPosition(
            this.#playback.itemId,
            this.#playback.positionMs,
            this.#playback.durationMs,
          );
        }
      },
    };
  }
}
