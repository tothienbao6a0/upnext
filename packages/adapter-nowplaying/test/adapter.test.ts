import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManualScheduler, Runtime } from 'upnext-core';
import { FakeAdapter } from 'upnext-core/testing';
import { NOW_PLAYING_URI, NowPlayingAdapter } from '../src/adapter.js';
import type { NowPlayingReading } from '../src/reading.js';

const flush = (n = 6) =>
  Array.from({ length: n }).reduce<Promise<void>>(
    (p) => p.then(() => new Promise((r) => setImmediate(r))),
    Promise.resolve(),
  );

const CHROME: NowPlayingReading = {
  bundleId: 'com.google.Chrome',
  label: 'Google Chrome',
  playing: true,
  title: 'Acquired — Jensen Huang',
  artist: 'YouTube',
  elapsedMs: 60_000,
  durationMs: 3_600_000,
};

/** A reader whose answer a test can change between polls. */
function source(initial: NowPlayingReading | null) {
  const state = { reading: initial, commands: [] as string[] };
  const adapter = new NowPlayingAdapter({
    read: async () => state.reading,
    send: async (command) => {
      state.commands.push(command);
      if (state.reading) state.reading = { ...state.reading, playing: command === 'play' };
      return true;
    },
  });
  return { adapter, state };
}

test('it answers to one entry and claims nothing else', () => {
  const { adapter } = source(CHROME);
  assert.equal(adapter.match({ uri: NOW_PLAYING_URI }), 1);
  assert.equal(adapter.match({ uri: 'spotify:track:1OWBh1eVxUdA1Z6UA8r4nh' }), 0);
  assert.equal(adapter.match({ uri: 'file:///a.mp3' }), 0);
  assert.equal(adapter.match({ title: 'Nights' }), 0, 'it cannot start anything');
});

test('it declares what it genuinely cannot do', () => {
  const { adapter } = source(CHROME);
  assert.equal(adapter.capabilities.seek, false, 'the bridge cannot pass seek options');
  assert.equal(adapter.capabilities.volume, false, 'the register exposes no volume');
  assert.equal(adapter.capabilities.search, false);
  assert.equal(adapter.capabilities.externalControl, true);
  assert.equal(adapter.capabilities.position, 'authoritative');
});

test('resolving adopts whatever is on, whichever app it is', async () => {
  const { adapter } = source(CHROME);
  const binding = await adapter.resolve({ uri: NOW_PLAYING_URI });

  assert.equal(binding?.ref.title, 'Acquired — Jensen Huang');
  assert.equal(binding?.ref.durationMs, 3_600_000);
  assert.deepEqual(binding?.ref.meta, { app: 'Google Chrome', bundleId: 'com.google.Chrome' });
});

test('with nothing playing there is nothing to adopt', async () => {
  const { adapter } = source(null);
  assert.equal(await adapter.resolve({ uri: NOW_PLAYING_URI }), null);
});

test('poll maps the register onto playback state', async () => {
  const { adapter, state } = source(CHROME);
  assert.equal((await adapter.poll()).status, 'playing');

  state.reading = { ...CHROME, playing: false };
  assert.equal((await adapter.poll()).status, 'paused');

  state.reading = { ...CHROME, playing: false, elapsedMs: CHROME.durationMs };
  assert.equal((await adapter.poll()).status, 'ended');

  state.reading = null;
  const gone = await adapter.poll();
  assert.equal(gone.status, 'ended', 'the app going away is the end of it');
  assert.equal(gone.nativeUri, null);
});

test('stopping pauses rather than taking somebody\'s podcast away', async () => {
  const { adapter, state } = source(CHROME);
  await adapter.stop();
  assert.deepEqual(state.commands, ['pause']);
});

test('let their podcast finish, then take over', async () => {
  const scheduler = new ManualScheduler();
  const { adapter, state } = source(CHROME);
  const mine = new FakeAdapter({
    id: 'mine',
    capabilities: { endOfTrack: 'event', position: 'estimated' },
  });

  const runtime = new Runtime({
    adapters: [adapter, mine],
    scheduler,
    pollIntervalMs: 500,
    lookahead: 0,
  });

  runtime.enqueue(NOW_PLAYING_URI);
  runtime.enqueue({ title: 'Bad Habit', artist: 'Steve Lacy' });
  await runtime.play();

  assert.equal(runtime.nowPlaying()?.ref.title, 'Acquired — Jensen Huang');
  assert.equal(runtime.getPlayback().adapterId, 'nowplaying');

  // Their episode reaches the end.
  state.reading = { ...CHROME, playing: false, elapsedMs: CHROME.durationMs };
  scheduler.advance(500);
  await flush();

  assert.equal(runtime.nowPlaying()?.ref.title, 'Bad Habit');
  assert.equal(runtime.getPlayback().adapterId, 'mine', 'ours took over when theirs finished');
  await runtime.dispose();
});

test('a person skipping in their browser is noticed and adopted', async () => {
  const scheduler = new ManualScheduler();
  const { adapter, state } = source(CHROME);
  const runtime = new Runtime({
    adapters: [adapter],
    scheduler,
    pollIntervalMs: 500,
    lookahead: 0,
  });
  const desyncs: string[] = [];
  runtime.on('desync', (d) => desyncs.push(d.action));

  runtime.enqueue(NOW_PLAYING_URI);
  await runtime.play();
  assert.equal(runtime.nowPlaying()?.ref.title, 'Acquired — Jensen Huang');

  // They pick something else in the tab. Different track, same app.
  state.reading = { ...CHROME, title: 'A Completely Different Video', elapsedMs: 0 };
  scheduler.advance(500);
  await flush();

  assert.deepEqual(desyncs, ['adopted'], 'their choice wins, and is recorded');
  assert.equal(runtime.getPlayback().status, 'playing');
  await runtime.dispose();
});

test('off macOS it reports itself unavailable instead of failing every entry', async () => {
  // No injected reader, so it probes for real. On macOS this is available; the
  // point is that either answer is a clean one the registry can act on.
  const runtime = new Runtime({ adapters: [new NowPlayingAdapter()] });
  await flush();

  const summary = runtime.getState().adapters[0]!;
  assert.equal(typeof summary.available, 'boolean');
  if (!summary.available) assert.match(summary.error?.message ?? '', /macOS/);
  await runtime.dispose();
});
