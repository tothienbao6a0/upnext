import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hasEnded,
  parseSearchResults,
  parseState,
  persistentIdFrom,
  trackUri,
} from '../src/parse.js';
import { DELIMITERS } from '../src/applescript.js';

const U = '\u001F';
const R = '\u001E';

// Tied to the shipped values rather than copied, because a fixture that drifts
// from the delimiters the scripts actually emit is a test that passes while the
// parser is broken. (It briefly did: the control characters did not survive
// being written into this file, so both were the empty string.)
test('fixtures use the delimiters the scripts really emit', () => {
  assert.equal(U, DELIMITERS.UNIT);
  assert.equal(R, DELIMITERS.RECORD);
});

/**
 * Captured verbatim from a real Music app on macOS 26.5.2, through the scripts
 * this package ships. If Apple renames a field or changes a unit, it fails
 * here rather than in somebody's speakers.
 */
const CAPTURED_STATE = `playing${U}citibike${U}baothiento${U}161.279998779297${U}10.218${U}46183534CB18CF36`;
const CAPTURED_SEARCH =
  `citibike${U}baothiento${U}161.279998779297${U}46183534CB18CF36${R}` +
  `citibike${U}${U}161.238998413086${U}3F4169AF8B8BE929${R}`;

test('a real reading parses, seconds turned into milliseconds', () => {
  assert.deepEqual(parseState(CAPTURED_STATE), {
    status: 'playing',
    title: 'citibike',
    artist: 'baothiento',
    durationMs: 161_280,
    positionMs: 10_218,
    persistentId: '46183534CB18CF36',
  });
});

test('a not-running app is nothing, not an error', () => {
  assert.equal(parseState('not-running'), null);
  assert.equal(parseState(''), null);
  assert.equal(parseState('   '), null);
});

test('the app sitting idle with nothing loaded is nothing to report', () => {
  assert.equal(parseState(`stopped${U}${U}${U}0${U}0${U}`), null);
});

test('stopped is not treated as ended', () => {
  // The app says stopped both when a track finished and when nothing was ever
  // loaded. Treating the second as "our track is over" would advance the queue
  // the instant it started.
  const reading = parseState(`stopped${U}Song${U}Artist${U}200${U}0${U}ABC123`)!;
  assert.equal(reading.status, 'idle');
  assert.equal(hasEnded(reading), false, 'at position zero, nothing has ended');
});

test('parked at the end counts as finished', () => {
  const base = parseState(CAPTURED_STATE)!;
  assert.equal(hasEnded({ ...base, status: 'paused', positionMs: base.durationMs }), true);
  assert.equal(hasEnded({ ...base, status: 'paused', positionMs: 60_000 }), false);
  assert.equal(
    hasEnded({ ...base, status: 'playing', positionMs: base.durationMs }),
    false,
    'still playing is not over, whatever the clock says',
  );
});

test('fast forwarding and rewinding are still playing', () => {
  assert.equal(parseState(`fast forwarding${U}S${U}A${U}10${U}1${U}X`)?.status, 'playing');
  assert.equal(parseState(`rewinding${U}S${U}A${U}10${U}1${U}X`)?.status, 'playing');
});

test('search results parse, including a track with no artist', () => {
  const hits = parseSearchResults(CAPTURED_SEARCH);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], {
    title: 'citibike',
    artist: 'baothiento',
    durationMs: 161_280,
    uri: 'applemusic:track:46183534CB18CF36',
  });
  assert.equal(hits[1]!.artist, '', 'a missing artist is empty, not a dropped row');
});

test('an empty or not-running search is an empty list', () => {
  assert.deepEqual(parseSearchResults(''), []);
  assert.deepEqual(parseSearchResults('not-running'), []);
});

test('a row with no persistent id is dropped — nothing could ever play it', () => {
  assert.deepEqual(parseSearchResults(`Title${U}Artist${U}100${U}${R}`), []);
});

test('a title containing a pipe survives, because the delimiter is not one', () => {
  // The reason for ASCII 31: every printable delimiter appears in real titles.
  const raw = `Song | Live${U}A|B${U}100${U}ID1${R}`;
  assert.deepEqual(parseSearchResults(raw)[0]?.title, 'Song | Live');
  assert.deepEqual(parseSearchResults(raw)[0]?.artist, 'A|B');
});

test('our locator round-trips, and rejects anything else', () => {
  assert.equal(trackUri('ABC123'), 'applemusic:track:ABC123');
  assert.equal(persistentIdFrom('applemusic:track:ABC123'), 'ABC123');
  assert.equal(persistentIdFrom('spotify:track:xyz'), null);
  assert.equal(persistentIdFrom('applemusic:album:ABC'), null);
  assert.equal(persistentIdFrom('nonsense'), null);
});
