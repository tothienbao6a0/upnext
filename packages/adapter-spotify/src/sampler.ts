import type { AdapterEvent } from 'upnext-core';
import type { Sample } from './applescript.js';

/**
 * Deciding what two consecutive readings of the Spotify app *mean*.
 *
 * This is the only genuinely hard code in the package, and it exists because of
 * one ambiguity the core cannot resolve on its own: **the track we loaded is no
 * longer the track that is playing.** That single observation has two completely
 * opposite causes.
 *
 *   Our track finished and Spotify's own queue rolled to the next thing.
 *     → the queue should advance to *our* next entry. This is `ended`.
 *
 *   A person picked up their phone and hit next, or clicked a different album.
 *     → the human wins. This is `external`, and the reconciler adopts it.
 *
 * Get it backwards and the library is broken in the most visible possible way:
 * either an agent's carefully built queue silently defers to Spotify's autoplay
 * after every single song, or a listener who chooses a song has it yanked away.
 *
 * What separates them is *where the playhead was on the previous reading*. A
 * rollover can only happen at the end of a track, so a change of track that
 * follows a sample near the end is a rollover, and a change that follows a
 * sample in the middle is a person. The core cannot make that call, because by
 * the time it sees the mismatch the evidence — the previous position — is gone.
 * The adapter can, because it kept it. This is exactly the kind of knowledge the
 * adapter contract exists to keep on the adapter's side.
 *
 * All of it is pure, and none of it needs a Mac. The state goes in and comes
 * back out, so every branch below is a plain table-driven test rather than
 * something you have to install Spotify and wait three minutes to observe.
 */

export interface WatchState {
  /** The previous reading, or null before the first one. */
  last: Sample | null;
  /** Have we ever seen Spotify actually playing the track we asked for? */
  confirmed: boolean;
  /** Readings taken since the load without that confirmation. */
  attempts: number;
  /** Whether the "it never started" complaint has already been made. */
  complained: boolean;
}

export const initialWatchState: WatchState = {
  last: null,
  confirmed: false,
  attempts: 0,
  complained: false,
};

export interface InterpretOptions {
  /**
   * How close to the end of a track counts as "at the end".
   *
   * Must be at least a couple of sampling intervals: the last reading before a
   * rollover can be a whole interval short of the duration, and if the window
   * is tighter than that, every natural track change is misread as a human
   * taking over. Erring wide is the safer direction — the cost of a window that
   * is slightly too generous is that a person who skips in the final seconds of
   * a song gets the same outcome they were going to get anyway.
   */
  rolloverWindowMs: number;
  /**
   * How many readings to wait for `play track` to take effect before saying it
   * did not. Spotify can take a moment to load a track, and until it has, the
   * app is still reporting whatever it was playing before.
   */
  confirmWithin: number;
}

export interface Interpretation {
  events: AdapterEvent[];
  state: WatchState;
}

export function interpret(
  ourUri: string,
  state: WatchState,
  next: Sample,
  opts: InterpretOptions,
): Interpretation {
  const events: AdapterEvent[] = [];
  const wasAtEnd = nearEnd(state.last, ourUri, opts.rolloverWindowMs);

  // -- the app is not open --------------------------------------------------
  if (!next.running) {
    // Quitting Spotify in the last seconds of a song is still that song being
    // over. Anywhere else it is the backend going away underneath us, which is
    // reported as paused because that is what a listener would say is true:
    // nothing is coming out of the speakers, and nothing is broken enough to
    // fail the entry over.
    if (wasAtEnd) return { events: [{ type: 'ended' }], state: { ...state, last: next } };
    if (state.last?.running !== false) events.push({ type: 'status', status: 'paused' });
    return { events, state: { ...state, last: next } };
  }

  // -- our track has not started yet ----------------------------------------
  if (!state.confirmed) {
    if (next.nativeUri !== ourUri) {
      const attempts = state.attempts + 1;
      // Whatever the app is still showing is the *previous* track, not a human
      // choosing something. Reporting it as a takeover here would let the track
      // we are in the middle of starting hijack its own start.
      if (attempts >= opts.confirmWithin && !state.complained) {
        events.push({
          type: 'error',
          code: 'not_playing',
          message: `Spotify did not start ${ourUri}; it is playing ${next.nativeUri ?? 'nothing'}`,
        });
        return { events, state: { ...state, last: next, attempts, complained: true } };
      }
      return { events, state: { ...state, last: next, attempts } };
    }
    return {
      events: report(state.last, next),
      state: { ...state, last: next, confirmed: true },
    };
  }

  // -- something else is playing --------------------------------------------
  if (next.nativeUri !== ourUri) {
    if (wasAtEnd) return { events: [{ type: 'ended' }], state: { ...state, last: next } };
    if (next.nativeUri === null) {
      // Spotify is open with nothing loaded. `external` carrying null is a
      // no-op to the reconciler by design — "reporting nothing" is not the same
      // as "reporting a different song" — so the honest signal is that playback
      // stopped.
      if (state.last?.nativeUri !== null) events.push({ type: 'status', status: 'paused' });
      return { events, state: { ...state, last: next } };
    }
    return {
      events: [{ type: 'external', nativeUri: next.nativeUri }],
      state: { ...state, last: next },
    };
  }

  // -- still our track ------------------------------------------------------
  // Spotify with no autoplay behind it parks at the end of the last track
  // rather than announcing anything, so a track that is at its end and no
  // longer playing is a track that is over. Without this the queue would sit
  // there, holding a finished song, waiting for a change that never comes.
  if (next.status !== 'playing' && atEnd(next, opts.rolloverWindowMs)) {
    return { events: [{ type: 'ended' }], state: { ...state, last: next } };
  }

  return { events: report(state.last, next), state: { ...state, last: next } };
}

/** Position every time, status only when it actually changed. */
function report(last: Sample | null, next: Sample): AdapterEvent[] {
  const events: AdapterEvent[] = [
    next.durationMs
      ? { type: 'position', positionMs: next.positionMs, durationMs: next.durationMs }
      : { type: 'position', positionMs: next.positionMs },
  ];
  if (last?.status !== next.status) {
    events.push({ type: 'status', status: next.status === 'idle' ? 'paused' : next.status });
  }
  return events;
}

/** Was the previous reading our track, at the end of it? */
function nearEnd(last: Sample | null, ourUri: string, windowMs: number): boolean {
  if (!last || !last.running || last.nativeUri !== ourUri) return false;
  return atEnd(last, windowMs);
}

function atEnd(sample: Sample, windowMs: number): boolean {
  if (sample.durationMs === null) return false;
  return sample.positionMs >= sample.durationMs - windowMs;
}
