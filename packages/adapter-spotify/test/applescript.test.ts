import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIELD,
  commandScript,
  commands,
  parseSample,
  playTrackScript,
  stateScript,
} from '../src/applescript.js';
import { CAPTURED_READING } from './fixtures.js';

/**
 * The wire format between this package and a program written in another
 * language, which only exists as a string until it runs. Nothing here is
 * type-checked by anything, so all of it is checked by hand.
 */

test('a reading captured from a real running Spotify parses correctly', () => {
  const sample = parseSample(CAPTURED_READING);
  assert.deepEqual(sample, {
    running: true,
    status: 'paused',
    // The app reports seconds; everything above this layer is milliseconds.
    positionMs: 276_000,
    // And reports the length in milliseconds already, which is the trap.
    durationMs: 276_000,
    nativeUri: 'spotify:track:1OWBh1eVxUdA1Z6UA8r4nh',
    volume: 0.76,
  });
});

test('empty output means the app is closed, which is not an error', () => {
  const sample = parseSample('');
  assert.equal(sample?.running, false);
  assert.equal(sample?.nativeUri, null);
});

test('a reading with nothing loaded keeps the fields it could not fill', () => {
  // Every property in the script sits behind its own `try`, so a Spotify that
  // is open but idle answers with blanks rather than failing the whole read.
  const sample = parseSample(['running', 'stopped', '0', '', '', '43'].join(FIELD));
  assert.deepEqual(sample, {
    running: true,
    status: 'idle',
    positionMs: 0,
    durationMs: null,
    nativeUri: null,
    volume: 0.43,
  });
});

test('malformed output answers null instead of a half-filled sample', () => {
  // A sample with a NaN playhead would be read as a real position and could end
  // a track that is still playing. A missing sample only costs one tick.
  assert.equal(parseSample('garbage'), null);
  assert.equal(parseSample(['running', 'playing'].join(FIELD)), null);
  assert.equal(parseSample(['nope', 'playing', '1', '', '', ''].join(FIELD)), null);
});

test('a non-Spotify track id is dropped rather than passed through', () => {
  // A local file in someone's library has no base-62 id, and inventing a
  // nativeUri for it would make every sample look like a takeover.
  const sample = parseSample(
    ['running', 'playing', '5', 'spotify:local:a:b:c:1', '200000', '50'].join(FIELD),
  );
  assert.equal(sample?.nativeUri, null);
});

test('the state script can never launch Spotify', () => {
  const script = stateScript();
  // The load-bearing line. A bare `tell application "Spotify"` launches it, so
  // a sampler running every second would boot a music player onto the machine
  // of someone who never opened one.
  assert.match(script, /if application "Spotify" is running then/);
  const guard = script.indexOf('is running then');
  const tell = script.indexOf('tell application "Spotify"');
  assert.ok(guard < tell, 'the running guard must come before the tell block');
});

test('every command except starting a track is behind the running guard', () => {
  for (const body of [commands.play, commands.pause, commands.seek(1000), commands.volume(0.5)]) {
    assert.match(commandScript(body), /^if application "Spotify" is running then/);
  }
});

test('starting a track is the one script allowed to launch the app', () => {
  const script = playTrackScript('spotify:track:abc123def456');
  assert.doesNotMatch(script, /is running/, 'an explicit play may open Spotify');
  assert.match(script, /play track "spotify:track:abc123def456"/);
  // Starting a song should not steal the foreground from whatever the person
  // is actually looking at.
  assert.doesNotMatch(script, /activate/);
});

test('a start offset waits for the track to load before moving the playhead', () => {
  const immediate = playTrackScript('spotify:track:abc123def456');
  assert.doesNotMatch(immediate, /set player position/, 'no offset, no extra work');

  const offset = playTrackScript('spotify:track:abc123def456', 30_000);
  assert.match(offset, /set player position to 30\b/, 'seconds, not milliseconds');
  assert.match(offset, /repeat 20 times/, 'play track returns before the track has loaded');
});

test('the transport verbs convert into the units the dictionary wants', () => {
  assert.equal(commands.seek(90_500), 'set player position to 91');
  assert.equal(commands.seek(-5), 'set player position to 0');
  assert.equal(commands.volume(0.5), 'set sound volume to 50');
  assert.equal(commands.volume(2), 'set sound volume to 100');
  assert.equal(commands.volume(-1), 'set sound volume to 0');
});

test('a URI is quoted before it becomes part of a program', () => {
  const script = playTrackScript('spotify:track:a"b\\c');
  assert.match(script, /play track "spotify:track:a\\"b\\\\c"/);
});
