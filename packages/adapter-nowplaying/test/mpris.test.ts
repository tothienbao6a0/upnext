import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORMAT, mprisAvailable, parseMpris, readMpris, sendMpris } from '../src/mpris.js';
import { sourceFor, UNSUPPORTED } from '../src/source.js';

/**
 * Two halves, and the split is the point.
 *
 * Above the line: the parser, driven by records this file builds. Fast, runs
 * everywhere, and covers the shapes a real player is unlikely to produce on
 * demand -- a stream with no length, a notification with no title, junk.
 *
 * Below the line: the same code driven through the real `playerctl` binary
 * against a real MPRIS player on a real session bus. That half exists because
 * the half above it cannot fail for the most likely reason this package is
 * wrong -- a format template playerctl does not accept. A parser fed records
 * of my own construction agrees with me by definition.
 */

/** ASCII 31, as an expression: an invisible byte does not survive editing. */
const U = String.fromCharCode(31);

/** The record shape this package asks for, filled in. */
const record = (over: Record<string, string> = {}) =>
  [
    over.player ?? 'vlc',
    over.status ?? 'Playing',
    over.title ?? 'Nights',
    over.artist ?? 'Frank Ocean',
    over.album ?? 'Blonde',
    over.position ?? '12500000', // microseconds
    over.length ?? '307000000',
  ].join(U);

test('the delimiter survived being written to disk', () => {
  // It did not, once: a test file's delimiter constant reached disk as the
  // empty string and three tests passed on nothing for a day.
  assert.equal(U.charCodeAt(0), 31);
  assert.equal(FORMAT.split(U).length, 7, 'the format is joined by the same byte');
});

test('the format asks for exactly the fields the parser reads', () => {
  // The shape is ours, not playerctl's -- that is what made this safe to write
  // at all. If a field is added to the template without the parser learning
  // about it, every later field shifts by one, and this catches that.
  assert.match(FORMAT, /\{\{playerName\}\}/);
  assert.match(FORMAT, /\{\{status\}\}/);
  assert.match(FORMAT, /\{\{default\(mpris:length,0\)\}\}/);
});

test('microseconds become milliseconds', () => {
  // Off by a thousand is the classic MPRIS bug.
  const reading = parseMpris(record())!;
  assert.equal(reading.elapsedMs, 12_500);
  assert.equal(reading.durationMs, 307_000);
});

test('a whole record parses whole', () => {
  assert.deepEqual(parseMpris(record()), {
    bundleId: 'vlc',
    label: 'vlc',
    playing: true,
    title: 'Nights',
    artist: 'Frank Ocean',
    album: 'Blonde',
    elapsedMs: 12_500,
    durationMs: 307_000,
  });
});

test('a browser is just another player', () => {
  const reading = parseMpris(record({ player: 'firefox', title: 'Some Interview' }))!;
  assert.equal(reading.bundleId, 'firefox');
  assert.equal(reading.title, 'Some Interview');
});

test('only Playing counts as playing', () => {
  assert.equal(parseMpris(record({ status: 'Playing' }))?.playing, true);
  assert.equal(parseMpris(record({ status: 'Paused' }))?.playing, false);
  assert.equal(parseMpris(record({ status: 'Stopped' }))?.playing, false);
});

test('a thing with no title or no length is not a track', () => {
  // The same filter as the macOS side, for the same reason: something that
  // made a noise is not necessarily something with a transport worth showing.
  assert.equal(parseMpris(record({ title: '' })), null);
  assert.equal(parseMpris(record({ length: '0' })), null);
});

test('nothing, junk, and a short record all answer null', () => {
  assert.equal(parseMpris(''), null);
  assert.equal(parseMpris('   '), null);
  assert.equal(parseMpris('No players found'), null);
  assert.equal(parseMpris(`only${U}three${U}fields`), null);
});

test('a missing album is dropped rather than carried as an empty string', () => {
  assert.equal(parseMpris(record({ album: '' }))?.album, undefined);
});

test('punctuation in a title is just punctuation', () => {
  // Every printable delimiter appears in some real title, which is the whole
  // argument for ASCII 31.
  const title = 'Nights: The Remix | Live, Pt. 2 - "reprise"';
  assert.equal(parseMpris(record({ title }))?.title, title);
});

test('a failing playerctl is an absence, not an error', async () => {
  const reading = await readMpris(async () => {
    throw new Error('No players found');
  });
  assert.equal(reading, null);
});

test('a command reports whether it landed', async () => {
  const sent: string[][] = [];
  assert.equal(
    await sendMpris('pause', async (args) => {
      sent.push(args);
      return '';
    }),
    true,
  );
  assert.deepEqual(sent, [['pause']]);

  assert.equal(
    await sendMpris('play', async () => {
      throw new Error('no player');
    }),
    false,
  );
});

test('playerctl has its own name for play-pause', async () => {
  // The one command whose name differs. Passing our name straight through
  // would fail at the shell, silently, as a false "no player".
  const sent: string[][] = [];
  const run = async (args: string[]) => {
    sent.push(args);
    return '';
  };
  await sendMpris('togglePlayPause', run);
  await sendMpris('previous', run);
  assert.deepEqual(sent, [['play-pause'], ['previous']]);
});

test('the platform decides which register is asked', () => {
  assert.equal(sourceFor('darwin')?.platform, 'darwin');
  assert.equal(sourceFor('linux')?.platform, 'linux');
  assert.equal(sourceFor('win32'), null, 'SMTC is not implemented, and does not pretend to be');
  assert.match(UNSUPPORTED, /macOS[\s\S]*Linux/);
});

// -- against the real binary, and a real player ------------------------------

const onLinux = process.platform === 'linux';
const havePlayerctl = onLinux && (await mprisAvailable());

/** CI starts the D-Bus fixture; without it these prove nothing and are skipped. */
const haveFixture = havePlayerctl && process.env.UPNEXT_MPRIS_FIXTURE === '1';

test('playerctl is present on the Linux leg', { skip: !onLinux }, () => {
  assert.equal(havePlayerctl, true, 'CI installs playerctl; see .github/workflows');
});

test('the fixture is on the bus', { skip: !haveFixture }, async () => {
  // Polled rather than slept: the player is a separate process and a fixed
  // wait is either a flake or a waste.
  const deadline = Date.now() + 10_000;
  let reading = await readMpris();
  while (!reading && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    reading = await readMpris();
  }
  assert.ok(reading, 'no MPRIS player appeared within 10s');
});

test('the real binary accepts this format, and fills it in', { skip: !haveFixture }, async () => {
  // The assertion this whole fixture exists for. A wrong variable name, a
  // function playerctl does not have, the wrong field order, or microseconds
  // read as milliseconds all fail here and nowhere else.
  const reading = await readMpris();
  assert.ok(reading, 'the fixture is playing; a null here means the template was rejected');

  assert.equal(reading.bundleId, 'upnextfixture');
  assert.equal(reading.playing, true);
  assert.equal(reading.title, 'Nights: The Remix | Live');
  assert.equal(reading.artist, 'Frank Ocean', 'xesam:artist is an array; playerctl flattens it');
  assert.equal(reading.album, 'Blonde');
  assert.equal(reading.durationMs, 307_000, 'microseconds, converted once');
  assert.equal(reading.elapsedMs, 12_500);
});

test('a command reaches the player and changes what a read sees', { skip: !haveFixture }, async () => {
  assert.equal(await sendMpris('pause'), true);

  const deadline = Date.now() + 5_000;
  let reading = await readMpris();
  while (reading?.playing !== false && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    reading = await readMpris();
  }
  assert.equal(reading?.playing, false, 'pause did not reach the player');

  assert.equal(await sendMpris('play'), true);
});
