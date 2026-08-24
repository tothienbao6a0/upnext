import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sample } from '../src/applescript.js';
import { initialWatchState, interpret, type WatchState } from '../src/sampler.js';

/**
 * The one genuinely hard decision in this package.
 *
 * "The track I loaded is not the track that is playing" has two opposite
 * causes — our song ended and Spotify moved on by itself, or a person hit next
 * — and they call for opposite responses. Getting it backwards breaks the
 * library in the most visible way there is: either an agent's queue silently
 * defers to Spotify's autoplay after every song, or a listener who picks a song
 * has it snatched away from them.
 *
 * Every branch is a table entry here, which is the whole reason this logic was
 * pulled out of the adapter: the alternative is installing Spotify and waiting
 * three minutes per case.
 */

const OURS = 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA';
const THEIRS = 'spotify:track:BBBBBBBBBBBBBBBBBBBBBB';
const DURATION = 200_000;

const OPTS = { rolloverWindowMs: 2000, confirmWithin: 5 };

function sample(overrides: Partial<Sample> = {}): Sample {
  return {
    running: true,
    status: 'playing',
    positionMs: 0,
    durationMs: DURATION,
    nativeUri: OURS,
    volume: 0.5,
    ...overrides,
  };
}

/** Walk a sequence of readings through, returning everything that came out. */
function run(samples: Sample[], from: WatchState = initialWatchState) {
  let state = from;
  const events = [];
  for (const next of samples) {
    const result = interpret(OURS, state, next, OPTS);
    state = result.state;
    events.push(...result.events);
  }
  return { events, state };
}

/** The state after our track has been confirmed playing at `positionMs`. */
function playing(positionMs: number): WatchState {
  return run([sample({ positionMs })]).state;
}

/**
 * Readings taken once our track is already established.
 *
 * Most of what follows is about a *change*, and starting from
 * `initialWatchState` would mix in the events of the first reading confirming
 * the track — which is real behaviour, tested on its own below, but noise here.
 */
function after(positionMs: number, samples: Sample[]) {
  return run(samples, playing(positionMs));
}

test('a track change right after the end of our track is our track ending', () => {
  const { events } = run([
    sample({ positionMs: DURATION - 500 }),
    sample({ positionMs: 3_000, nativeUri: THEIRS }),
  ]);
  assert.deepEqual(
    events.filter((event) => event.type === 'ended'),
    [{ type: 'ended' }],
    'Spotify rolling over at the end of a song must advance OUR queue',
  );
  assert.equal(
    events.some((event) => event.type === 'external'),
    false,
    'a natural rollover is not a human taking over',
  );
});

test('a track change in the middle of our track is a person taking over', () => {
  const { events } = after(40_000, [sample({ positionMs: 1_000, nativeUri: THEIRS })]);
  assert.deepEqual(events, [{ type: 'external', nativeUri: THEIRS }]);
});

test('the rollover window absorbs a sampling gap, since the last reading is always short', () => {
  // The final reading before a rollover can be a whole interval away from the
  // end. A window tighter than that reads every natural track change as a
  // takeover — which is the failure that makes an agent-owned queue useless.
  const inside = after(DURATION - OPTS.rolloverWindowMs, [
    sample({ positionMs: 0, nativeUri: THEIRS }),
  ]);
  assert.deepEqual(inside.events, [{ type: 'ended' }]);

  const outside = after(DURATION - OPTS.rolloverWindowMs - 1, [
    sample({ positionMs: 0, nativeUri: THEIRS }),
  ]);
  assert.deepEqual(
    outside.events,
    [{ type: 'external', nativeUri: THEIRS }],
    'outside the window it is a person',
  );
});

test('a track we never started cannot hijack its own start', () => {
  // Spotify keeps reporting the previous song for a beat after `play track`.
  // Read as a takeover, that would adopt the old track over the one we are in
  // the middle of starting.
  const { events, state } = run([
    sample({ nativeUri: THEIRS }),
    sample({ nativeUri: THEIRS }),
  ]);
  assert.deepEqual(events, [], 'silence until our track actually appears');
  assert.equal(state.confirmed, false);
});

test('once our track appears, later changes are meaningful again', () => {
  const { state } = run([sample({ nativeUri: THEIRS }), sample({ positionMs: 100 })]);
  assert.equal(state.confirmed, true);

  const after = interpret(OURS, state, sample({ positionMs: 0, nativeUri: THEIRS }), OPTS);
  assert.deepEqual(after.events, [{ type: 'external', nativeUri: THEIRS }]);
});

test('a play that never took hold is reported once, not every second', () => {
  const readings = Array.from({ length: 12 }, () => sample({ nativeUri: THEIRS }));
  const { events } = run(readings);
  const errors = events.filter((event) => event.type === 'error');
  assert.equal(errors.length, 1, 'one complaint, however long it goes on');
  assert.equal(errors[0]?.type === 'error' && errors[0].code, 'not_playing');
});

test('a track parked at its end with nothing playing is a track that is over', () => {
  // Exactly what a real Spotify does at the end of a queue with no autoplay
  // behind it: it stops, and goes on reporting the finished song forever.
  // Without this the queue would sit there holding a song that ended.
  const { events } = run([
    sample({ positionMs: DURATION - 1000 }),
    sample({ positionMs: DURATION, status: 'paused' }),
  ]);
  assert.equal(events.at(-1)?.type, 'ended');
});

test('a pause in the middle of a track is a pause, not an ending', () => {
  const { events } = after(30_000, [sample({ positionMs: 30_000, status: 'paused' })]);
  assert.equal(
    events.some((event) => event.type === 'ended'),
    false,
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'status'),
    [{ type: 'status', status: 'paused' }],
  );
});

test('position is reported every reading; status only when it changed', () => {
  const { events } = run([
    sample({ positionMs: 1000 }),
    sample({ positionMs: 2000 }),
    sample({ positionMs: 3000 }),
  ]);
  assert.equal(events.filter((event) => event.type === 'position').length, 3);
  assert.equal(
    events.filter((event) => event.type === 'status').length,
    1,
    'a host should not repaint on news that nothing changed',
  );
});

test('position carries the duration, so the runtime learns how long the track is', () => {
  const { events } = run([sample({ positionMs: 5000 })]);
  assert.deepEqual(events[0], { type: 'position', positionMs: 5000, durationMs: DURATION });
});

test('quitting Spotify near the end still ends the track', () => {
  const { events } = run([
    sample({ positionMs: DURATION - 500 }),
    sample({ running: false, status: 'idle', nativeUri: null, durationMs: null }),
  ]);
  assert.equal(events.at(-1)?.type, 'ended');
});

test('quitting Spotify mid-track is a pause, reported once', () => {
  const gone = { running: false, status: 'idle' as const, nativeUri: null, durationMs: null };
  const { events } = after(20_000, [sample(gone), sample(gone), sample(gone)]);
  assert.deepEqual(
    events.filter((event) => event.type === 'status'),
    [{ type: 'status', status: 'paused' }],
    'the app being closed is one piece of news, not one per second',
  );
  assert.equal(
    events.some((event) => event.type === 'ended'),
    false,
    'a track the listener walked away from is not a track that finished',
  );
});

test('Spotify open with nothing loaded is a pause, not a takeover', () => {
  // `external` carrying null is a no-op to the reconciler by design — reporting
  // nothing is not the same as reporting a different song — so emitting one
  // here would mean the runtime is told nothing at all.
  const { events } = interpret(OURS, playing(50_000), sample({ nativeUri: null }), OPTS);
  assert.deepEqual(events, [{ type: 'status', status: 'paused' }]);
});

test('a track with no known duration never ends by guesswork', () => {
  const { events } = run([
    sample({ positionMs: 500_000, durationMs: null }),
    sample({ positionMs: 0, nativeUri: THEIRS, durationMs: null }),
  ]);
  assert.equal(
    events.at(-1)?.type,
    'external',
    'with no duration there is no "near the end" to reason from',
  );
});
