import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManualScheduler, Runtime } from 'upnext-core';
import { AppleMusicAdapter } from '../src/adapter.js';
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

const LIBRARY =
  `Bad Habit${U}Steve Lacy${U}232.5${U}AAA111${R}` +
  `Bad Habits${U}Ed Sheeran${U}231.0${U}BBB222${R}` +
  `Nights${U}Frank Ocean${U}307.0${U}CCC333${R}`;

/** A Music app made of strings: every script gets a canned answer. */
function fake(overrides: { state?: string; search?: string } = {}) {
  const ran: string[] = [];
  const state = { current: overrides.state ?? `playing${U}Bad Habit${U}Steve Lacy${U}232.5${U}12.0${U}AAA111` };

  const adapter = new AppleMusicAdapter({
    run: async (script) => {
      ran.push(script);
      if (script.includes('id of application')) return 'com.apple.Music';
      if (script.includes('search playlist')) return overrides.search ?? LIBRARY;
      if (script.includes('player state')) return state.current;
      return 'ok';
    },
  });

  return { adapter, ran, state };
}

test('it declares the thing that makes it worth having', () => {
  const { adapter } = fake();
  assert.equal(adapter.capabilities.search, true, 'the whole reason this is not a Spotify clone');
  assert.equal(adapter.capabilities.externalControl, true);
  assert.equal(adapter.capabilities.position, 'authoritative');
  assert.equal(adapter.capabilities.seek, true);
});

test('a bare title resolves with no credentials at all', async () => {
  const { adapter } = fake();
  const binding = await adapter.resolve({ title: 'Bad Habit', artist: 'Steve Lacy' });

  assert.equal(binding?.nativeUri, 'applemusic:track:AAA111');
  assert.equal(binding?.ref.artist, 'Steve Lacy');
});

test('it picks the right one when the library has near-misses', async () => {
  const { adapter } = fake();
  // "Bad Habits" by Ed Sheeran is one character away and would be an easy,
  // confident, wrong answer.
  const binding = await adapter.resolve({ title: 'Bad Habit', artist: 'Steve Lacy' });
  assert.equal(binding?.nativeUri, 'applemusic:track:AAA111');

  const other = await adapter.resolve({ title: 'Bad Habits', artist: 'Ed Sheeran' });
  assert.equal(other?.nativeUri, 'applemusic:track:BBB222');
});

test('a title nothing in the library resembles is refused, not guessed', async () => {
  const { adapter } = fake();
  assert.equal(await adapter.resolve({ title: 'A Song Nobody Owns', artist: 'Nobody' }), null);
});

test('an empty library is a refusal too', async () => {
  const { adapter } = fake({ search: '' });
  assert.equal(await adapter.resolve({ title: 'Bad Habit' }), null);
});

test('match claims titles and its own uris, and nothing else', () => {
  const { adapter } = fake();
  assert.equal(adapter.match({ uri: 'applemusic:track:AAA111' }), 1);
  assert.equal(adapter.match({ title: 'Bad Habit' }), 0.5);
  assert.equal(adapter.match({ uri: 'spotify:track:xyz' }), 0);
  assert.equal(adapter.match({ uri: 'file:///a.mp3' }), 0);
  assert.equal(adapter.match({}), 0);
});

test('reading state never starts playback', async () => {
  const { adapter, ran } = fake();
  await adapter.poll();
  await adapter.search('bad habit');
  await adapter.resolve({ title: 'Nights', artist: 'Frank Ocean' });

  // A status poll that starts a music player is not a status poll.
  assert.ok(!ran.some((s) => /\bplay\b/.test(s)), 'a read path ran a play command');
});

test('every script refuses to launch the app', () => {
  const { adapter, ran } = fake();
  void adapter.poll();
  void adapter.search('x');
  void adapter.pause();
  for (const script of ran.filter((s) => !s.includes('id of application'))) {
    assert.match(script, /if application "Music" is running then/, `unguarded script:\n${script}`);
  }
});

test('stopping pauses rather than quitting', async () => {
  const { adapter, ran } = fake();
  await adapter.stop();
  assert.ok(ran.some((s) => s.includes('pause')));
  assert.ok(!ran.some((s) => /\bquit\b/.test(s)), 'never close somebody\'s music app');
});

test('volume is converted from the contract to the app\'s own scale', async () => {
  const { adapter, ran } = fake();
  await adapter.setVolume(0.4);
  assert.ok(ran.some((s) => s.includes('set sound volume to 40')));
});

test('a search term with a quote cannot break out of the script', async () => {
  const { adapter, ran } = fake();
  await adapter.search('say "hello" \\ goodbye');
  const script = ran.find((s) => s.includes('search playlist'))!;
  assert.ok(script.includes('\\"hello\\"'), `unescaped quote in:\n${script}`);
  assert.ok(script.includes('\\\\'), 'unescaped backslash');
});

test('the runtime drives it end to end', async () => {
  const { adapter, state } = fake();
  const runtime = new Runtime({
    adapters: [adapter],
    scheduler: new ManualScheduler(),
    pollIntervalMs: 500,
    lookahead: 0,
  });

  runtime.enqueue({ title: 'Bad Habit', artist: 'Steve Lacy' });
  await runtime.play();

  assert.equal(runtime.getPlayback().adapterId, 'apple-music');
  assert.equal(runtime.nowPlaying()?.ref.title, 'Bad Habit');
  assert.equal(runtime.can('search'), true);

  // Somebody hits next in the app.
  state.current = `playing${U}Nights${U}Frank Ocean${U}307.0${U}1.0${U}CCC333`;
  const desyncs: string[] = [];
  runtime.on('desync', (d) => desyncs.push(d.action));
  await adapter.poll();

  await runtime.dispose();
});

test('off macOS it fails init cleanly rather than failing every entry', async () => {
  const adapter = new AppleMusicAdapter({
    run: async () => {
      throw new Error('osascript: command not found');
    },
  });
  await assert.rejects(() => adapter.init(), /needs macOS/);
});
