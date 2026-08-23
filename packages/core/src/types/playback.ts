import type { Capabilities } from './capabilities.js';

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended';

export interface PlaybackState {
  status: PlaybackStatus;
  /** Queue item currently loaded, if any. */
  itemId: string | null;
  adapterId: string | null;
  positionMs: number;
  durationMs: number | null;
  /**
   * What the backend currently playing can actually do, inline.
   *
   * The whole point of the capability model is that an agent knows before it
   * calls. Publishing capabilities only as a separate per-adapter list would
   * make "can I seek right now?" a join against `adapterId` on every single
   * decision, which is exactly the friction this library exists to remove.
   *
   * `null` when nothing is loaded. `capabilities.position` is also how much to
   * trust `positionMs`.
   */
  capabilities: Capabilities | null;
  volume: number | null;
}

export const idlePlayback: PlaybackState = {
  status: 'idle',
  itemId: null,
  adapterId: null,
  positionMs: 0,
  durationMs: null,
  capabilities: null,
  volume: null,
};
