import type { MediaRef, PlaybackStatus } from 'upnext-core';
import { DELIMITERS } from './applescript.js';

/**
 * Turning the app's answers into data.
 *
 * Kept pure and apart from the scripts that fetch them, so every decision here
 * runs in a test with no macOS, no Music app and no library — which is where
 * this package's CI runs.
 */

export interface MusicReading {
  status: PlaybackStatus;
  title: string;
  artist: string;
  durationMs: number;
  positionMs: number;
  /** The app's own stable handle for the track. */
  persistentId: string;
}

/** Our locator. Stable across restarts, and the thing `play` takes. */
export function trackUri(persistentId: string): string {
  return `applemusic:track:${persistentId}`;
}

export function persistentIdFrom(uri: string): string | null {
  const match = /^applemusic:track:([A-Za-z0-9]+)$/.exec(uri.trim());
  return match?.[1] ?? null;
}

/**
 * Map the app's player state onto the contract's.
 *
 * `stopped` is deliberately *not* `ended`. The app reports stopped both when a
 * track finished and when nothing was ever loaded, and treating the second as
 * "our track is over" would advance the queue the instant it started. Whether
 * something ended is decided from the playhead instead — see `hasEnded`.
 */
function toStatus(raw: string): PlaybackStatus {
  switch (raw.trim().toLowerCase()) {
    case 'playing':
      return 'playing';
    case 'paused':
      return 'paused';
    case 'fast forwarding':
    case 'rewinding':
      return 'playing';
    default:
      return 'idle';
  }
}

export function parseState(raw: string): MusicReading | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'not-running') return null;

  const parts = trimmed.split(DELIMITERS.UNIT);
  if (parts.length < 6) return null;

  const [state = '', title = '', artist = '', duration = '', position = '', persistentId = ''] =
    parts;

  // A reading with no track is the app sitting idle, which is a real state but
  // not one anything can be built on.
  if (!persistentId.trim() && !title.trim()) return null;

  return {
    status: toStatus(state),
    title: title.trim(),
    artist: artist.trim(),
    durationMs: seconds(duration),
    positionMs: seconds(position),
    persistentId: persistentId.trim(),
  };
}

/**
 * Has the loaded track finished?
 *
 * Same shape of problem every desktop player has: it parks at the end and goes
 * on reporting the finished track, so waiting for the position to pass the
 * duration waits for ever.
 */
export function hasEnded(reading: MusicReading): boolean {
  if (reading.status === 'playing') return false;
  if (reading.durationMs <= 0) return false;
  return reading.positionMs >= reading.durationMs - 1500;
}

export function parseSearchResults(raw: string): MediaRef[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'not-running') return [];

  const refs: MediaRef[] = [];
  for (const record of trimmed.split(DELIMITERS.RECORD)) {
    if (!record.trim()) continue;
    const [title = '', artist = '', duration = '', persistentId = ''] = record.split(
      DELIMITERS.UNIT,
    );
    if (!persistentId.trim()) continue;

    refs.push({
      title: title.trim(),
      artist: artist.trim(),
      durationMs: seconds(duration),
      uri: trackUri(persistentId.trim()),
    });
  }
  return refs;
}

/** The app answers in seconds, sometimes with a long float tail. */
function seconds(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}
