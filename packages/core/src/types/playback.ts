import type { Capabilities } from './capabilities.js';

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended';

export interface PlaybackState {
  status: PlaybackStatus;
  /** Queue item currently loaded, if any. */
  itemId: string | null;
  adapterId: string | null;
  positionMs: number;
  durationMs: number | null;
  /** How much to trust `positionMs`. Mirrors the active adapter's capability. */
  positionSource: Capabilities['position'];
  volume: number | null;
}

export const idlePlayback: PlaybackState = {
  status: 'idle',
  itemId: null,
  adapterId: null,
  positionMs: 0,
  durationMs: null,
  positionSource: 'none',
  volume: null,
};
