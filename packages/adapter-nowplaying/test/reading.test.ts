import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasEnded, parseReading, readingUri } from '../src/reading.js';

/**
 * Captured verbatim from a real macOS 26.5.2 machine, from the JXA script this
 * package ships. If Apple changes a field name or a unit, this is where it
 * fails — in a test, rather than in somebody's speakers.
 */
const CAPTURED =
  '{"bundleId":"com.spotify.client","label":"Spotify","playing":false,"title":"Florence",' +
  '"artist":"Malcolm Todd","album":"Malcolm Todd","elapsed":185,"duration":185}';

test('a real reading parses, with seconds turned into milliseconds', () => {
  const reading = parseReading(CAPTURED);
  assert.deepEqual(reading, {
    bundleId: 'com.spotify.client',
    label: 'Spotify',
    playing: false,
    title: 'Florence',
    artist: 'Malcolm Todd',
    album: 'Malcolm Todd',
    elapsedMs: 185_000,
    durationMs: 185_000,
  });
});

test('a browser tab is just another app', () => {
  const reading = parseReading(
    '{"bundleId":"com.google.Chrome","label":"Google Chrome","playing":true,' +
      '"title":"Some Interview","artist":"YouTube","elapsed":12.5,"duration":3600}',
  );
  assert.equal(reading?.bundleId, 'com.google.Chrome');
  assert.equal(reading?.elapsedMs, 12_500);
  assert.equal(reading?.playing, true);
});

test('a notification chime is not a track', () => {
  // macOS's now-playing client is whatever last made a sound. A received voice
  // message leaves Messages sitting there with no title and a few seconds of
  // "track" — a transport bar on that would be nonsense.
  assert.equal(
    parseReading('{"bundleId":"com.apple.MobileSMS","label":"Messages","playing":false,"title":"","artist":"","elapsed":0,"duration":7}'),
    null,
  );
  assert.equal(
    parseReading('{"bundleId":"x","label":"x","playing":true,"title":"Something","artist":"","elapsed":0,"duration":0}'),
    null,
    'no real duration means nothing is really playing',
  );
});

test('nothing playing, and junk, both answer null rather than throwing', () => {
  assert.equal(parseReading(''), null);
  assert.equal(parseReading('   '), null);
  assert.equal(parseReading('NO_CLASS'), null);
  assert.equal(parseReading('{not json'), null);
});

test('the synthesised locator changes when the track does', () => {
  const base = parseReading(CAPTURED)!;
  const same = { ...base, elapsedMs: 90_000, playing: true };
  const other = { ...base, title: 'A Different Song' };
  const otherApp = { ...base, bundleId: 'com.google.Chrome' };

  assert.equal(readingUri(base), readingUri(same), 'position moving is not a new track');
  assert.notEqual(readingUri(base), readingUri(other));
  assert.notEqual(readingUri(base), readingUri(otherApp));
  assert.ok(readingUri(base).startsWith('nowplaying:com.spotify.client:'));
});

test('parked at the end counts as finished', () => {
  const base = parseReading(CAPTURED)!;
  // Players sit at exactly their duration and go on reporting the finished
  // track forever. Waiting for elapsed to exceed duration waits for ever.
  assert.equal(hasEnded(base), true);
  assert.equal(hasEnded({ ...base, elapsedMs: 90_000 }), false, 'paused mid-track is not over');
  assert.equal(
    hasEnded({ ...base, playing: true }),
    false,
    'still playing is not over, whatever the clock says',
  );
});
