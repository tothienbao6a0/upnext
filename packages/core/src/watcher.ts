import { PositionTracker } from './position.js';
import { toSerializedError } from './errors.js';
import type { Scheduler } from './scheduler.js';
import type {
  Adapter,
  AdapterEvent,
  Binding,
  MediaRef,
  PlaybackStatus,
  SerializedError,
} from './types/index.js';

export interface WatcherHandlers {
  onEnded(): void;
  onPosition(positionMs: number, durationMs?: number): void;
  onStatus(status: PlaybackStatus): void;
  onExternal(nativeUri: string | null, ref?: MediaRef): void;
  onError(error: SerializedError): void;
}

export interface WatcherOptions {
  scheduler: Scheduler;
  pollIntervalMs: number;
  positionIntervalMs: number;
}

/**
 * Everything time-dependent about one loaded item.
 *
 * A watcher exists for exactly as long as its item is the active one. It knows
 * how to learn that a track finished on a backend that pushes events, one that
 * must be polled, and one that can only be timed — the three points on the
 * `endOfTrack` capability spectrum. Nothing else in the runtime touches timers.
 */
export class Watcher {
  readonly adapter: Adapter;
  readonly binding: Binding;

  #position: PositionTracker;
  #opts: WatcherOptions;
  #handlers: WatcherHandlers;
  #durationMs: number | null;
  #endTimer: unknown = null;
  #pollTimer: unknown = null;
  #tickTimer: unknown = null;
  #stopped = false;
  #warnedNoDuration = false;

  constructor(
    adapter: Adapter,
    binding: Binding,
    handlers: WatcherHandlers,
    opts: WatcherOptions,
  ) {
    this.adapter = adapter;
    this.binding = binding;
    this.#handlers = handlers;
    this.#opts = opts;
    this.#position = new PositionTracker(opts.scheduler);
    this.#durationMs = binding.ref.durationMs ?? null;
  }

  get positionMs(): number {
    return this.#position.value;
  }

  get durationMs(): number | null {
    return this.#durationMs;
  }

  /** Begin watching. The item is assumed to be playing from `startAtMs`. */
  start(startAtMs = 0): void {
    this.#position.set(startAtMs);
    this.#position.start();
    this.#armEndOfTrack();
    this.#armPoll();
    this.#armTick();
  }

  pause(): void {
    this.#position.stop();
    this.#clearEndTimer();
  }

  resume(): void {
    this.#position.start();
    this.#armEndOfTrack();
  }

  /** After a seek: re-anchor and recompute the end-of-track timer. */
  reanchor(positionMs: number): void {
    this.#position.set(positionMs);
    this.#armEndOfTrack();
  }

  stop(): void {
    this.#stopped = true;
    this.#position.stop();
    this.#clearEndTimer();
    if (this.#pollTimer !== null) {
      this.#opts.scheduler.clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#tickTimer !== null) {
      this.#opts.scheduler.clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
  }

  /** Route an event pushed by the backend this watcher is watching. */
  handleEvent(event: AdapterEvent): void {
    if (this.#stopped) return;
    switch (event.type) {
      case 'ended':
        this.#end();
        break;
      case 'position':
        this.#position.set(event.positionMs);
        if (event.durationMs) this.#durationMs = event.durationMs;
        this.#handlers.onPosition(event.positionMs, event.durationMs);
        break;
      case 'status':
        if (event.status === 'paused') this.#position.stop();
        if (event.status === 'playing') this.#position.start();
        this.#handlers.onStatus(event.status);
        break;
      case 'external':
        this.#handlers.onExternal(event.nativeUri, event.ref);
        break;
      case 'error':
        this.#handlers.onError({
          code: event.code,
          message: event.message,
          adapterId: this.adapter.id,
        });
        break;
    }
  }

  // -- arming ---------------------------------------------------------------

  /**
   * Backends that cannot tell us a track ended get a duration timer. It is a
   * guess, and `Capabilities.endOfTrack` marks it as one — but a queue that
   * silently stops at the end of the first song is worse than one that advances
   * a beat early.
   */
  #armEndOfTrack(): void {
    this.#clearEndTimer();
    if (this.#stopped) return;
    if (this.adapter.capabilities.endOfTrack !== 'none') return;
    if (!this.#durationMs) {
      // A backend that cannot announce the end of a track and does not know how
      // long it is leaves nothing to advance on, so the queue would simply stop
      // here. Say so once, rather than looking like playback hung.
      if (!this.#warnedNoDuration) {
        this.#warnedNoDuration = true;
        this.#handlers.onError({
          code: 'no_duration',
          message:
            `${this.adapter.id} cannot report end-of-track and gave no duration for ` +
            `${this.binding.nativeUri}, so the queue will not advance on its own`,
          adapterId: this.adapter.id,
        });
      }
      return;
    }

    const remaining = Math.max(0, this.#durationMs - this.#position.value);
    this.#endTimer = this.#opts.scheduler.setTimeout(() => {
      this.#endTimer = null;
      this.#end();
    }, remaining);
  }

  #armPoll(): void {
    const caps = this.adapter.capabilities;
    const needsPoll = caps.endOfTrack === 'poll' || caps.position === 'authoritative';
    if (!needsPoll || !this.adapter.poll) return;
    this.#pollTimer = this.#opts.scheduler.setInterval(() => {
      void this.#poll();
    }, this.#opts.pollIntervalMs);
  }

  /** Emit position updates for backends the runtime has to extrapolate for. */
  #armTick(): void {
    if (this.adapter.capabilities.position !== 'estimated') return;
    this.#tickTimer = this.#opts.scheduler.setInterval(() => {
      if (this.#stopped) return;
      this.#handlers.onPosition(this.#position.value);
    }, this.#opts.positionIntervalMs);
  }

  async #poll(): Promise<void> {
    if (this.#stopped || !this.adapter.poll) return;
    let state;
    try {
      state = await this.adapter.poll();
    } catch (err) {
      this.#handlers.onError(toSerializedError(err, this.adapter.id));
      return;
    }
    if (this.#stopped) return;

    if (state.durationMs) this.#durationMs = state.durationMs;
    if (state.positionMs !== undefined) {
      this.#position.set(state.positionMs);
      this.#handlers.onPosition(state.positionMs, state.durationMs);
    }
    if (state.nativeUri !== undefined && state.nativeUri !== this.binding.nativeUri) {
      this.#handlers.onExternal(state.nativeUri);
      if (this.#stopped) return;
    }

    if (this.adapter.capabilities.endOfTrack === 'poll' && this.#finished(state.status, state.positionMs)) {
      this.#end();
    }
  }

  #finished(status: PlaybackStatus, positionMs: number | undefined): boolean {
    if (status === 'ended' || status === 'idle') return true;
    if (this.#durationMs === null || positionMs === undefined) return false;
    // A poll interval can straddle the end of a track, so treat "nearly there"
    // as done rather than waiting for a tick that reports past the duration.
    return positionMs >= this.#durationMs - 250;
  }

  #end(): void {
    if (this.#stopped) return;
    this.stop();
    this.#handlers.onEnded();
  }

  #clearEndTimer(): void {
    if (this.#endTimer !== null) {
      this.#opts.scheduler.clearTimeout(this.#endTimer);
      this.#endTimer = null;
    }
  }
}
