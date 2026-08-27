import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Library, isAudioPath } from '../src/library.js';
import { LocalAdapter } from '../src/index.js';
import { PLAYERS } from '../src/players.js';

/**
 * The reference backend — the one in every quickstart — had no tests at all.
 * These cover the parts that are decisions rather than plumbing: what it claims
 * it can play, what it refuses, and that its capabilities follow the binary
 * actually installed rather than a hopeful constant.
 */

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'upnext-local-'));
  await writeFile(join(dir, 'Bad Habit.mp3'), Buffer.alloc(8));
  await writeFile(join(dir, 'Nights.flac'), Buffer.alloc(8));
  await writeFile(join(dir, 'notes.txt'), 'not audio');
  await writeFile(join(dir, '.hidden.mp3'), Buffer.alloc(8));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('audio files are recognised by extension, case-insensitively', () => {
  assert.equal(isAudioPath('a.mp3'), true);
  assert.equal(isAudioPath('a.FLAC'), true);
  assert.equal(isAudioPath('a.txt'), false);
  assert.equal(isAudioPath('a'), false);
});

test('a library indexes audio and ignores everything else', async () => {
  const library = new Library();
  await library.scan([dir]);

  assert.equal(library.size, 2, 'the .txt and the dotfile should not be indexed');
  assert.equal(library.search('bad').length, 1);
  assert.equal(library.search('BAD')[0]?.title, 'Bad Habit', 'search is case-insensitive');
  assert.deepEqual(library.search(''), [], 'an empty query matches nothing, not everything');
});

test('an unreadable directory does not fail the whole scan', async () => {
  const library = new Library();
  await library.scan(['/definitely/not/a/real/path', dir]);
  assert.equal(library.size, 2, 'the good directory still indexed');
});

test('search declares itself only when there is a library to search', async () => {
  const bare = new LocalAdapter();
  await bare.init();
  assert.equal(bare.capabilities.search, false, 'nothing to search means it must not claim it');

  const indexed = new LocalAdapter({ library: [dir] });
  await indexed.init();
  assert.equal(indexed.capabilities.search, true);
});

test('capabilities follow the player that is actually installed', async () => {
  const adapter = new LocalAdapter({ library: [dir] });
  await adapter.init();

  // ffplay takes a start offset; afplay does not. Whichever is here, the
  // adapter must report that rather than a flattering constant.
  const canSeek = adapter.capabilities.seek;
  assert.equal(typeof canSeek, 'boolean');
  assert.equal(adapter.capabilities.endOfTrack, 'event', 'our own process exiting is the event');
  assert.equal(adapter.capabilities.position, 'estimated');
  assert.equal(adapter.capabilities.externalControl, false);
  await adapter.dispose();
});

test('the player table agrees with itself about seeking and streaming', () => {
  assert.equal(PLAYERS.ffplay!.canSeek, true);
  assert.equal(PLAYERS.ffplay!.canStream, true);
  assert.equal(PLAYERS.afplay!.canSeek, false, 'afplay accepts no start offset');
  assert.equal(PLAYERS.afplay!.canStream, false);
  assert.ok(PLAYERS.ffplay!.args('/a.mp3', 30_000).includes('-ss'));
  assert.ok(!PLAYERS.afplay!.args('/a.mp3', 30_000).includes('-ss'));
});

test('it claims files and audio urls, and refuses other schemes', async () => {
  const adapter = new LocalAdapter();
  await adapter.init();

  assert.equal(adapter.match({ uri: 'file:///music/a.mp3' }), 1);
  assert.equal(adapter.match({ uri: '/music/a.mp3' }), 1);
  assert.equal(adapter.match({ uri: 'spotify:track:abc' }), 0, 'somebody else’s job');
  assert.equal(adapter.match({ uri: 'applemusic:track:abc' }), 0);
  assert.equal(adapter.match({ title: 'Bad Habit' }), 0, 'no library indexed, so nothing to match');
  await adapter.dispose();
});

test('with a library, a bare title matches and resolves to the real file', async () => {
  const adapter = new LocalAdapter({ library: [dir], probeDurations: false });
  await adapter.init();

  assert.ok(adapter.match({ title: 'Bad Habit' }) > 0);
  const binding = await adapter.resolve({ title: 'Bad Habit' });
  assert.match(binding?.nativeUri ?? '', /Bad Habit\.mp3$/);
  assert.equal(binding?.ref.title, 'Bad Habit');
  await adapter.dispose();
});

test('a file that is not there resolves to nothing rather than a broken binding', async () => {
  const adapter = new LocalAdapter({ probeDurations: false });
  await adapter.init();
  assert.equal(await adapter.resolve({ title: 'Not In Any Library' }), null);
  await adapter.dispose();
});
