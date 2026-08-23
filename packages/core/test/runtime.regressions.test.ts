import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { FakeAdapter } from '../src/testing.js';
import { EVENT_CAPS, harness } from './fixtures.js';
import { collect, deferred, flush } from './helpers.js';

/**
 * Everything here was found by running the library out loud rather than by
 * reading it. Each one is a state race that a synchronous read of the code
 * makes look impossible.
 */

test('an entry finishing is announced exactly once', async () => {
  const { runtime, adapter } = harness();
  const ended = collect(runtime, 'item:ended');

  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  await runtime.play();
  adapter.finish();
  await flush();

  const forFirst = ended.filter((e) => e.item.ref.title === 'one');
  assert.equal(forFirst.length, 1, 'ended fired more than once for the same entry');
  assert.equal(forFirst[0]!.reason, 'completed');
});

test('skipping announces the skip, not a skip and a replacement', async () => {
  const { runtime } = harness();
  const ended = collect(runtime, 'item:ended');

  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  await runtime.play();
  await runtime.next();
  await flush();

  const forFirst = ended.filter((e) => e.item.ref.title === 'one');
  assert.equal(forFirst.length, 1);
  assert.equal(forFirst[0]!.reason, 'skipped');
});

test('a prefetch landing late does not overwrite the entry that is now playing', async () => {
  const gate = deferred();
  const adapter = new FakeAdapter({ capabilities: EVENT_CAPS });
  const resolve = adapter.resolve.bind(adapter);
  let calls = 0;
  adapter.resolve = async (ref) => {
    // Only the prefetch is held open. The play path must be free to overtake
    // it, which is the whole point of the race being tested.
    if (++calls === 1) await gate.promise;
    return resolve(ref);
  };

  const runtime = new Runtime({
    adapters: [adapter],
    scheduler: new ManualScheduler(),
    lookahead: 2,
  });

  runtime.enqueue({ title: 'slow-to-prepare' });
  await flush();

  // The entry starts playing while its own prefetch is still in flight.
  await runtime.play();
  gate.resolve();
  await flush();

  assert.equal(runtime.nowPlaying()?.status, 'active');
  assert.equal(runtime.getQueue()[0]!.status, 'active');
});

test('reaching the end of the queue does not flash idle on the way to ended', async () => {
  const { runtime, adapter } = harness();
  const states = collect(runtime, 'playback:changed');

  runtime.enqueue({ title: 'only' });
  await runtime.play();
  states.length = 0;

  adapter.finish();
  await flush();

  assert.deepEqual(
    states.map((s) => s.status),
    ['ended'],
    'subscribers must not see a spurious idle before ended',
  );
});

test('replaying an entry that already failed everywhere gets a fresh attempt', async () => {
  let broken = true;
  const adapter = new FakeAdapter({ capabilities: EVENT_CAPS });
  const load = adapter.load.bind(adapter);
  adapter.load = async (binding) => {
    if (broken) throw new Error('backend having a moment');
    return load(binding);
  };

  const runtime = new Runtime({ adapters: [adapter], scheduler: new ManualScheduler() });
  const item = runtime.enqueue({ title: 'one' });
  await runtime.play();
  await flush();
  assert.equal(runtime.getQueue()[0]!.status, 'failed');

  broken = false;
  await runtime.play(item.id);

  assert.equal(runtime.nowPlaying()?.ref.title, 'one');
  assert.equal(runtime.getPlayback().status, 'playing');
});
