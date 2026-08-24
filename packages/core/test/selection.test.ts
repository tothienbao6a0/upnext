import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { selectNext } from '../src/selection.js';
import { Queue, createQueueView } from '../src/queue.js';
import type { ItemStatus, QueueItem } from '../src/types/index.js';
import { EVENT_CAPS, harness } from './fixtures.js';
import { flush } from './helpers.js';

function queueOf(...statuses: Array<[string, ItemStatus]>) {
  const queue = new Queue();
  for (const [id, status] of statuses) {
    queue.insert({ id, status, ref: { title: id }, addedAt: 0 } as QueueItem);
  }
  return createQueueView(queue);
}

const first = () => 0;

// -- the plan, in isolation -------------------------------------------------

test('in order, it walks forward and then stops', () => {
  const q = queueOf(['a', 'ended'], ['b', 'ready'], ['c', 'ready']);
  assert.deepEqual(selectNext(q, 'a', { repeat: 'off', shuffle: false }, first), {
    kind: 'play',
    id: 'b',
  });

  const spent = queueOf(['a', 'ended'], ['b', 'ended']);
  assert.deepEqual(selectNext(spent, 'b', { repeat: 'off', shuffle: false }, first), {
    kind: 'stop',
  });
});

test('repeat one outranks shuffle', () => {
  const q = queueOf(['a', 'ended'], ['b', 'ready'], ['c', 'ready']);
  assert.deepEqual(selectNext(q, 'a', { repeat: 'one', shuffle: true }, first), {
    kind: 'replay',
    id: 'a',
  });
});

test('repeat all revives the queue only once nothing is left', () => {
  const remaining = queueOf(['a', 'ended'], ['b', 'ready']);
  assert.equal(selectNext(remaining, 'a', { repeat: 'all', shuffle: false }, first).kind, 'play');

  const spent = queueOf(['a', 'ended'], ['b', 'skipped']);
  assert.deepEqual(selectNext(spent, 'b', { repeat: 'all', shuffle: false }, first), {
    kind: 'restart',
    id: 'a',
  });
});

test('a failed entry is never revived, even by repeat all', () => {
  const q = queueOf(['a', 'failed'], ['b', 'ended']);
  assert.deepEqual(selectNext(q, 'b', { repeat: 'all', shuffle: false }, first), {
    kind: 'restart',
    id: 'b',
  });
});

test('shuffle picks from everything unplayed, not just what is ahead', () => {
  const q = queueOf(['a', 'ready'], ['b', 'ended'], ['c', 'ready']);
  // random() → 0 selects the first *playable*, which is 'a' — behind the cursor.
  assert.deepEqual(selectNext(q, 'b', { repeat: 'off', shuffle: true }, first), {
    kind: 'play',
    id: 'a',
  });
  // random() → 0.99 selects the last.
  assert.deepEqual(selectNext(q, 'b', { repeat: 'off', shuffle: true }, () => 0.99), {
    kind: 'play',
    id: 'c',
  });
});

test('a random() of exactly 1 does not fall off the end', () => {
  const q = queueOf(['a', 'ready'], ['b', 'ready']);
  assert.deepEqual(selectNext(q, null, { repeat: 'off', shuffle: true }, () => 1), {
    kind: 'play',
    id: 'b',
  });
});

// -- through the runtime ----------------------------------------------------

test('repeat one plays the same entry again', async () => {
  const { runtime, adapter } = harness();
  runtime.setRepeat('one');
  runtime.enqueue({ title: 'only' });
  runtime.enqueue({ title: 'never reached' });
  await runtime.play();

  adapter.finish();
  await flush();

  assert.equal(runtime.nowPlaying()?.ref.title, 'only');
  assert.equal(runtime.getPlayback().status, 'playing');
});

test('repeat all wraps to the top instead of ending', async () => {
  const { runtime, adapter } = harness();
  runtime.setRepeat('all');
  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  await runtime.play();

  adapter.finish();
  await flush();
  assert.equal(runtime.nowPlaying()?.ref.title, 'two');

  adapter.finish();
  await flush();
  assert.equal(runtime.nowPlaying()?.ref.title, 'one', 'should have wrapped');
  assert.equal(runtime.getPlayback().status, 'playing');
});

test('without repeat the queue still ends', async () => {
  const { runtime, adapter } = harness();
  runtime.enqueue({ title: 'one' });
  await runtime.play();
  adapter.finish();
  await flush();

  assert.equal(runtime.getPlayback().status, 'ended');
});

test('shuffle is reproducible when the randomness is', async () => {
  const order: string[] = [];
  const runtime = new Runtime({
    adapters: [new (await import('../src/testing.js')).FakeAdapter({ capabilities: EVENT_CAPS })],
    scheduler: new ManualScheduler(),
    shuffle: true,
    random: () => 0, // always the first remaining entry
  });
  runtime.on('item:started', ({ item }) => order.push(item.ref.title ?? ''));

  runtime.enqueue({ title: 'a' });
  runtime.enqueue({ title: 'b' });
  runtime.enqueue({ title: 'c' });
  await runtime.play();
  await flush();

  assert.deepEqual(order, ['a'], 'first pick is deterministic');
  assert.equal(runtime.shuffle, true);
});

test('repeat and shuffle are visible in a snapshot', () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  assert.equal(runtime.getState().repeat, 'off');
  assert.equal(runtime.getState().shuffle, false);

  runtime.setRepeat('all');
  runtime.setShuffle(true);
  assert.equal(runtime.getState().repeat, 'all');
  assert.equal(runtime.getState().shuffle, true);
});

// -- dispose ----------------------------------------------------------------

test('a disposed runtime refuses writes instead of accepting them quietly', async () => {
  const { runtime } = harness();
  runtime.enqueue({ title: 'one' });
  await runtime.dispose();

  assert.throws(() => runtime.enqueue({ title: 'two' }), /disposed/);
  assert.throws(() => runtime.clear(), /disposed/);
  assert.equal(runtime.getQueue().length, 1, 'and the queue is untouched');
});
