import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { FakeAdapter } from '../src/testing.js';
import { BLIND_CAPS, EVENT_CAPS, POLL_CAPS, harness } from './fixtures.js';
import { collect, flush } from './helpers.js';

test('plays the first entry and reports what is happening', async () => {
  const { runtime, adapter } = harness({ defaultDurationMs: 1000 });
  const started = collect(runtime, 'item:started');

  runtime.enqueue({ title: 'Bad Habit', artist: 'Steve Lacy' });
  await runtime.play();

  assert.equal(started.length, 1);
  assert.equal(started[0]!.item.ref.title, 'Bad Habit');

  const state = runtime.getState();
  assert.equal(state.playback.status, 'playing');
  assert.equal(state.nowPlaying?.status, 'active');
  assert.deepEqual(adapter.calls.slice(-3), ['resolve', 'load', 'play']);
});

test('advances when an event-driven backend says the track ended', async () => {
  const { runtime, adapter } = harness();
  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  await runtime.play();
  assert.equal(runtime.nowPlaying()?.ref.title, 'one');

  adapter.finish();
  await flush();

  assert.equal(runtime.nowPlaying()?.ref.title, 'two');
  assert.equal(runtime.getQueue()[0]!.status, 'ended');
});

test('advances on a duration timer when the backend can report nothing', async () => {
  const { runtime, scheduler } = harness({
    capabilities: BLIND_CAPS,
    defaultDurationMs: 5000,
  });
  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  await runtime.play();

  scheduler.advance(4000);
  await flush();
  assert.equal(runtime.nowPlaying()?.ref.title, 'one', 'must not advance early');

  scheduler.advance(1000);
  await flush();
  assert.equal(runtime.nowPlaying()?.ref.title, 'two');
});

test('advances on poll when the backend can only be asked', async () => {
  const { runtime, adapter, scheduler } = harness(
    { capabilities: POLL_CAPS, defaultDurationMs: 3000 },
    { pollIntervalMs: 500 },
  );
  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  await runtime.play();

  adapter.setPosition(1000);
  scheduler.advance(500);
  await flush();
  assert.equal(runtime.getPlayback().positionMs, 1000);
  assert.equal(runtime.getPlayback().positionSource, 'authoritative');

  adapter.setPosition(3000);
  scheduler.advance(500);
  await flush();
  assert.equal(runtime.nowPlaying()?.ref.title, 'two');
});

test('estimated position ticks forward without help from the backend', async () => {
  const { runtime, scheduler } = harness({ defaultDurationMs: 60_000 });
  runtime.enqueue({ title: 'one' });
  await runtime.play();
  scheduler.advance(3000);

  assert.equal(runtime.getPlayback().positionMs, 3000);
  assert.equal(runtime.getPlayback().positionSource, 'estimated');
});

test('pausing stops the estimated clock', async () => {
  const { runtime, scheduler } = harness({ defaultDurationMs: 60_000 });
  runtime.enqueue({ title: 'one' });
  await runtime.play();
  scheduler.advance(2000);
  await runtime.pause();
  scheduler.advance(10_000);

  assert.equal(runtime.getPlayback().status, 'paused');
  assert.equal(runtime.getPlayback().positionMs, 2000);
});

test('a paused track does not advance on its duration timer', async () => {
  const { runtime, scheduler } = harness({
    capabilities: { ...BLIND_CAPS, pause: true },
    defaultDurationMs: 5000,
  });
  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  await runtime.play();

  scheduler.advance(1000);
  await runtime.pause();
  scheduler.advance(60_000);
  await flush();

  assert.equal(runtime.nowPlaying()?.ref.title, 'one');

  await runtime.resume();
  scheduler.advance(4000);
  await flush();
  assert.equal(runtime.nowPlaying()?.ref.title, 'two');
});

test('seeking re-anchors the end-of-track timer', async () => {
  const { runtime, scheduler } = harness({
    capabilities: { ...BLIND_CAPS, seek: true },
    defaultDurationMs: 10_000,
  });
  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  await runtime.play();

  await runtime.seek(9000);
  scheduler.advance(1000);
  await flush();

  assert.equal(runtime.nowPlaying()?.ref.title, 'two');
});

test('unsupported transport calls fail loudly rather than pretending', async () => {
  const { runtime } = harness({ capabilities: { endOfTrack: 'event', pause: false } });
  runtime.enqueue({ title: 'one' });
  await runtime.play();

  await assert.rejects(() => runtime.pause(), /cannot pause/);
  await assert.rejects(() => runtime.seek(1000), /cannot seek/);
});

test('the queue ends cleanly when nothing is left', async () => {
  const { runtime, adapter } = harness();
  runtime.enqueue({ title: 'only' });
  await runtime.play();

  adapter.finish();
  await flush();

  assert.equal(runtime.getPlayback().status, 'ended');
  assert.equal(runtime.nowPlaying(), null);
});

test('previous replays the entry before the current one', async () => {
  const { runtime } = harness();
  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  await runtime.play();
  await runtime.next();
  assert.equal(runtime.nowPlaying()?.ref.title, 'two');

  await runtime.previous();
  assert.equal(runtime.nowPlaying()?.ref.title, 'one');
});

test('playNow jumps the queue without discarding it', async () => {
  const { runtime } = harness();
  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  await runtime.play();

  await runtime.playNow({ title: 'urgent' });

  assert.equal(runtime.nowPlaying()?.ref.title, 'urgent');
  assert.deepEqual(
    runtime.getQueue().map((i) => i.ref.title),
    ['one', 'urgent', 'two'],
  );
});

test('two backends do not both end up playing', async () => {
  const scheduler = new ManualScheduler();
  const a = new FakeAdapter({ id: 'a', capabilities: EVENT_CAPS });
  const b = new FakeAdapter({ id: 'b', capabilities: EVENT_CAPS });
  const runtime = new Runtime({ adapters: [a, b], scheduler });

  runtime.enqueue({ uri: 'a:one' });
  runtime.enqueue({ uri: 'b:two' });
  await runtime.play();
  assert.equal(a.status, 'playing');

  await runtime.next();
  assert.equal(a.status, 'idle', 'the previous backend must be stopped');
  assert.equal(b.status, 'playing');
});
