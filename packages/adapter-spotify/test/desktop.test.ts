import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManualScheduler, Runtime } from 'upnext-core';
import type { Adapter, RuntimeEvents } from 'upnext-core';
import { SpotifyDesktopAdapter } from '../src/desktop.js';
import { FakeSpotify, flush } from './fixtures.js';

/**
 * The desktop backend driving a real `Runtime`, with a stand-in for the app.
 *
 * These are the tests that matter most, because the two cases below are the
 * whole reason this adapter is more than a hundred lines: Spotify moving on by
 * itself must advance *our* queue, and a person moving it must not be
 * overruled. Both are invisible to a unit test of any single function.
 */

const A = 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA';
const B = 'spotify:track:BBBBBBBBBBBBBBBBBBBBBB';
const HUMAN = 'spotify:track:HHHHHHHHHHHHHHHHHHHHHH';

async function harness(options: { desyncPolicy?: 'adopt' | 'correct' | 'ignore' } = {}) {
  const scheduler = new ManualScheduler();
  const spotify = new FakeSpotify();
  const adapter = new SpotifyDesktopAdapter({
    osascript: spotify.osascript,
    scheduler,
    platform: 'darwin',
    // No network in a unit test; a bare URI is a perfectly good queue entry.
    lookup: null,
    sampleIntervalMs: 1000,
  });
  const runtime = new Runtime({ adapters: [adapter], scheduler, ...options });
  // `init` is started by the registry and not awaited by the constructor.
  await flush();
  return { runtime, adapter, spotify, scheduler };
}

/** Advance the shared clock and let the resulting promise chains settle. */
async function tick(scheduler: ManualScheduler, ms = 1000): Promise<void> {
  scheduler.advance(ms);
  await flush();
}

function collect<K extends keyof RuntimeEvents>(runtime: Runtime, event: K): RuntimeEvents[K][] {
  const out: RuntimeEvents[K][] = [];
  runtime.on(event, (payload) => out.push(payload));
  return out;
}

test('a Spotify URI plays through the desktop app', async () => {
  const { runtime, spotify } = await harness();
  runtime.enqueue(A);
  await runtime.play();

  assert.deepEqual(spotify.played, [A], 'the app was told to play exactly this track');
  assert.equal(runtime.getPlayback().status, 'playing');
  assert.equal(runtime.nowPlaying()?.ref.uri, A);
  await runtime.dispose();
});

test('a share link and a URI reach the same track', async () => {
  const { runtime, spotify } = await harness();
  runtime.enqueue('https://open.spotify.com/intl-de/track/AAAAAAAAAAAAAAAAAAAAAA?si=x');
  await runtime.play();
  assert.deepEqual(spotify.played, [A]);
  await runtime.dispose();
});

test('Spotify rolling over at the end of a track advances OUR queue', async () => {
  const { runtime, spotify, scheduler } = await harness();
  runtime.enqueue(A);
  runtime.enqueue(B);
  await runtime.play();

  await tick(scheduler); // our track, at the start
  spotify.toEnd();
  await tick(scheduler); // our track, at the end

  // Spotify's own autoplay picks something we never queued.
  spotify.switchTo('spotify:track:ZZZZZZZZZZZZZZZZZZZZZZ');
  await tick(scheduler);
  await flush();

  assert.equal(
    runtime.nowPlaying()?.ref.uri,
    B,
    'the queue advances to the entry the agent queued, not to Spotify autoplay',
  );
  assert.deepEqual(spotify.played, [A, B]);
  await runtime.dispose();
});

test('a person hitting next in the app wins, and the queue absorbs their choice', async () => {
  const { runtime, spotify, scheduler } = await harness();
  const desyncs = collect(runtime, 'desync');
  runtime.enqueue(A);
  runtime.enqueue(B);
  await runtime.play();

  await tick(scheduler); // confirmed on our track
  spotify.state.positionSeconds = 30; // nowhere near the end
  await tick(scheduler);

  spotify.switchTo(HUMAN);
  await tick(scheduler);
  await flush();

  assert.equal(desyncs.length, 1, 'the takeover is reported');
  assert.equal(desyncs[0]?.action, 'adopted');
  assert.equal(runtime.nowPlaying()?.ref.uri, HUMAN, 'the human wins by default');
  assert.deepEqual(spotify.played, [A], 'and nothing was forced back on top of them');
  await runtime.dispose();
});

test('a takeover is one event, not one per second', async () => {
  // The bug this guards: after the runtime adopts what the listener chose, an
  // adapter still comparing against the abandoned track would announce a
  // takeover again on every reading — and each one would add another entry.
  const { runtime, spotify, scheduler } = await harness();
  const desyncs = collect(runtime, 'desync');
  runtime.enqueue(A);
  await runtime.play();

  await tick(scheduler);
  spotify.state.positionSeconds = 30;
  await tick(scheduler);
  spotify.switchTo(HUMAN);

  for (let i = 0; i < 5; i++) await tick(scheduler);
  await flush();

  assert.equal(desyncs.length, 1, 'following the backend is not the same as re-reporting it');
  assert.equal(runtime.getQueue().length, 2, 'one adopted entry, not one per reading');
  await runtime.dispose();
});

test("with policy 'correct' the runtime puts its own track back", async () => {
  const { runtime, spotify, scheduler } = await harness({ desyncPolicy: 'correct' });
  const desyncs = collect(runtime, 'desync');
  runtime.enqueue(A);
  await runtime.play();

  await tick(scheduler);
  spotify.state.positionSeconds = 30;
  await tick(scheduler);
  spotify.switchTo(HUMAN);
  await tick(scheduler);
  await flush();

  assert.equal(desyncs[0]?.action, 'corrected');
  assert.deepEqual(spotify.played, [A, A], 'the original track was restarted on the backend');
  await runtime.dispose();
});

test('a track parked at its end still ends the entry', async () => {
  // Spotify with nothing behind it stops and goes on reporting the finished
  // song. Without handling that, a queue would hang on its last-but-one entry.
  const { runtime, spotify, scheduler } = await harness();
  runtime.enqueue(A);
  runtime.enqueue(B);
  await runtime.play();

  await tick(scheduler);
  spotify.toEnd();
  spotify.state.status = 'paused';
  await tick(scheduler);
  await flush();

  assert.equal(runtime.nowPlaying()?.ref.uri, B);
  await runtime.dispose();
});

test('the playhead reported by the app reaches the runtime', async () => {
  const { runtime, spotify, scheduler } = await harness();
  const positions = collect(runtime, 'position');
  runtime.enqueue(A);
  await runtime.play();

  spotify.state.positionSeconds = 42;
  await tick(scheduler);

  assert.equal(positions.at(-1)?.positionMs, 42_000, 'seconds in, milliseconds out');
  assert.equal(runtime.getPlayback().durationMs, 210_000);
  assert.equal(
    runtime.getPlayback().capabilities?.position,
    'authoritative',
    'and it is marked as a real reading rather than an extrapolation',
  );
  await runtime.dispose();
});

test('transport verbs reach the app in its own units', async () => {
  const { runtime, spotify } = await harness();
  runtime.enqueue(A);
  await runtime.play();

  await runtime.seek(90_000);
  assert.equal(spotify.state.positionSeconds, 90);

  await runtime.setVolume(0.25);
  assert.equal(spotify.state.volume, 25);

  await runtime.pause();
  assert.equal(spotify.state.status, 'paused');
  await runtime.resume();
  assert.equal(spotify.state.status, 'playing');
  await runtime.dispose();
});

test('the adapter refuses to be chosen for things it cannot play', async () => {
  const { runtime, adapter } = await harness();
  // No search means no way to get from a title to a URI, so scoring anything
  // else above zero would win the entry away from an adapter that could
  // actually have played it.
  assert.equal(adapter.match({ title: 'Bad Habit', artist: 'Steve Lacy' }), 0);
  assert.equal(adapter.match({ isrc: 'USUM72209293' }), 0);
  assert.equal(adapter.match({ uri: 'file:///music/song.mp3' }), 0);
  assert.equal(adapter.match({ uri: 'spotify:album:AAAAAAAAAAAAAAAAAAAAAA' }), 0, 'a container');
  assert.equal(adapter.match({ uri: A }), 1);
  await runtime.dispose();
});

test('the capability block says what it can do and, more usefully, what it cannot', async () => {
  const { runtime, adapter } = await harness();
  assert.equal(adapter.capabilities.search, false, 'the dictionary cannot search a catalogue');
  assert.equal(adapter.capabilities.externalControl, true, 'a human shares this backend with us');
  assert.equal(adapter.capabilities.position, 'authoritative');
  assert.equal(adapter.capabilities.endOfTrack, 'event');
  // Read through the contract rather than the class: `poll` being absent is a
  // decision about the interface, not an implementation detail. Declaring
  // `position: 'authoritative'` would otherwise make the runtime's watcher poll
  // this adapter on a timer of its own, on top of the one it already runs.
  const contract: Adapter = adapter;
  assert.equal(contract.poll, undefined);
  await runtime.dispose();
});

test('off macOS the backend excludes itself instead of failing every track', async () => {
  const spotify = new FakeSpotify();
  const adapter = new SpotifyDesktopAdapter({
    osascript: spotify.osascript,
    platform: 'linux',
    lookup: null,
  });
  const runtime = new Runtime({ adapters: [adapter] });
  await flush();

  const summary = runtime.getState().adapters[0];
  assert.equal(summary?.available, false);
  assert.match(String(summary?.error?.message), /cannot run on linux/);
  await runtime.dispose();
});

test('a machine without the Spotify app says so at startup, not at the first song', async () => {
  const spotify = new FakeSpotify();
  spotify.installed = false;
  const adapter = new SpotifyDesktopAdapter({
    osascript: spotify.osascript,
    platform: 'darwin',
    lookup: null,
  });
  const runtime = new Runtime({ adapters: [adapter] });
  await flush();

  assert.equal(runtime.getState().adapters[0]?.available, false);
  await runtime.dispose();
});

test('a sampling failure is reported once per outage', async () => {
  const scheduler = new ManualScheduler();
  const spotify = new FakeSpotify();
  let broken = false;
  const adapter = new SpotifyDesktopAdapter({
    osascript: async (script) => {
      if (broken && script.startsWith('on run')) throw new Error('Not authorized to send Apple events');
      return spotify.osascript(script);
    },
    scheduler,
    platform: 'darwin',
    lookup: null,
    sampleIntervalMs: 1000,
  });
  const runtime = new Runtime({ adapters: [adapter], scheduler });
  await flush();

  const errors = collect(runtime, 'adapter:error');
  runtime.enqueue(A);
  await runtime.play();
  broken = true;

  for (let i = 0; i < 4; i++) await tick(scheduler);

  assert.equal(
    errors.length,
    1,
    'a denied permission is one piece of news, not one every second for as long as the queue is open',
  );
  await runtime.dispose();
});

test('stopping pauses rather than quitting somebody’s music player', async () => {
  const { runtime, spotify } = await harness();
  runtime.enqueue(A);
  await runtime.play();
  await runtime.stop();

  assert.equal(spotify.state.status, 'paused');
  assert.equal(
    spotify.scripts.some((script) => /\bquit\b/.test(script)),
    false,
  );
  await runtime.dispose();
});
