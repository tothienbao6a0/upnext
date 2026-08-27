import type { Capabilities } from './capabilities.js';
import type { Binding, MediaRef } from './media.js';
import type { PlaybackStatus } from './playback.js';

/** Pushed by an adapter to tell the runtime what its backend is doing. */
export type AdapterEvent =
  /** The loaded item finished on its own. */
  | { type: 'ended' }
  | { type: 'position'; positionMs: number; durationMs?: number }
  | { type: 'status'; status: PlaybackStatus }
  /**
   * The backend is now playing something the runtime did not load — a human
   * pressed next in the native app, or its own queue rolled over.
   */
  | { type: 'external'; nativeUri: string | null; ref?: MediaRef }
  | { type: 'error'; code: string; message: string };

/**
 * A point-in-time read of a backend, for adapters that cannot push.
 *
 * A *reading*, not a state: it is one sample taken by asking, and the next one
 * may disagree because somebody pressed a button in between. `PlaybackState` is
 * the runtime's settled view; this is the raw measurement it is derived from,
 * and keeping the two named apart keeps an adapter author from reaching for the
 * wrong one.
 */
export interface AdapterReading {
  status: PlaybackStatus;
  positionMs?: number;
  durationMs?: number;
  /** What the backend believes it is playing. Used to detect desync. */
  nativeUri?: string | null;
}

/**
 * A playback backend.
 *
 * Only `id`, `capabilities`, `match`, `resolve`, `load`, `play` and `stop` are
 * required. Everything else is optional and gated by `capabilities`, so a
 * thirty-line adapter is a legitimate adapter.
 *
 * Adapters do not have to be written in TypeScript, or even run in this
 * process — see `upnext-adapter-process` for the out-of-process form of this exact
 * contract.
 */
export interface Adapter {
  readonly id: string;
  readonly capabilities: Capabilities;

  /**
   * How well this adapter can handle a ref, from 0 (not at all) to 1 (certain).
   * Called on every resolution, so it must be cheap and synchronous — no I/O.
   */
  match(ref: MediaRef): number;

  /**
   * Turn a ref into something this adapter can actually play. Return null if it
   * turns out it cannot, and the runtime will try the next adapter.
   */
  resolve(ref: MediaRef): Promise<Binding | null>;

  search?(query: string, limit?: number): Promise<MediaRef[]>;

  load(binding: Binding, opts?: { startAtMs?: number }): Promise<void>;
  play(): Promise<void>;
  pause?(): Promise<void>;
  stop(): Promise<void>;
  seek?(positionMs: number): Promise<void>;
  setVolume?(volume: number): Promise<void>;

  /** Required when `capabilities.endOfTrack` or `position` is `poll`. */
  poll?(): Promise<AdapterReading>;
  /** Required when `capabilities.endOfTrack` is `event`. */
  subscribe?(listener: (event: AdapterEvent) => void): () => void;

  init?(): Promise<void>;
  dispose?(): Promise<void>;
}
