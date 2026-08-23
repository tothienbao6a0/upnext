import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { harness } from './fixtures.js';
import { collect, flush } from './helpers.js';

test('id-addressed mutation survives the queue moving underneath', () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  const a = runtime.enqueue({ title: 'a' });
  const b = runtime.enqueue({ title: 'b' });
  const c = runtime.enqueue({ title: 'c' });

  runtime.move(c.id, { before: a.id });
  assert.deepEqual(runtime.getQueue().map((i) => i.ref.title), ['c', 'a', 'b']);

  runtime.remove(b.id);
  assert.deepEqual(runtime.getQueue().map((i) => i.ref.title), ['c', 'a']);
});

test('optimistic concurrency rejects a write against a stale version', () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  const a = runtime.enqueue({ title: 'a' });
  const stale = runtime.getState().version;
  runtime.enqueue({ title: 'b' });

  assert.throws(() => runtime.move(a.id, { end: true }, stale), /caller expected/);
});

test('a burst of mutations announces once, carrying the settled state', async () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  const changes = collect(runtime, 'queue:changed');

  const a = runtime.enqueue({ title: 'a' });
  runtime.enqueue({ title: 'b' });
  runtime.move(a.id, { end: true });
  runtime.remove(a.id);
  await flush();

  assert.equal(changes.length, 1, 'four mutations in one turn are one logical change');
  assert.equal(changes[0]!.version, runtime.getState().version);
  assert.deepEqual(changes[0]!.queue.map((i) => i.ref.title), ['b']);
});

test('separate turns announce separately', async () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  const changes = collect(runtime, 'queue:changed');

  runtime.enqueue({ title: 'a' });
  await flush();
  runtime.enqueue({ title: 'b' });
  await flush();

  assert.equal(changes.length, 2);
  assert.ok(changes[1]!.version > changes[0]!.version);
});

test('starting a track is one announcement, not one per internal write', async () => {
  const { runtime } = harness({}, { lookahead: 0 });
  runtime.enqueue({ title: 'one' });
  await flush();

  const changes = collect(runtime, 'queue:changed');
  await runtime.play();
  await flush();

  assert.equal(changes.length, 1, 'clearing attempts, binding and activating is one change');
  assert.equal(changes[0]!.queue[0]!.status, 'active', 'and it carries the settled state');
});

test('edits made before an operation are announced before it', async () => {
  const { runtime } = harness({}, { lookahead: 0 });
  const order: string[] = [];
  runtime.on('queue:changed', () => order.push('queue'));
  runtime.on('item:started', () => order.push('started'));

  runtime.enqueue({ title: 'one' });
  await runtime.play();
  await flush();

  assert.equal(order[0], 'queue', 'the host should see the queue it built before it starts');
  assert.ok(order.includes('started'));
});

test('reads are never deferred, only the announcement is', () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  runtime.enqueue({ title: 'a' });

  // No await: an agent that enqueues and immediately reads must see its write.
  assert.equal(runtime.getQueue().length, 1);
  assert.equal(runtime.queue.length, 1);
  assert.equal(runtime.getState().queue[0]!.ref.title, 'a');
});

test('enqueueMany keeps the order it was given', () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  runtime.enqueue({ title: 'existing' });
  runtime.enqueueMany([{ title: 'a' }, { title: 'b' }, { title: 'c' }], { next: true });

  assert.deepEqual(
    runtime.getQueue().map((i) => i.ref.title),
    ['a', 'b', 'c', 'existing'],
  );
});

test('removing the active entry advances instead of leaving silence', async () => {
  const { runtime } = harness();
  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  await runtime.play();

  const activeId = runtime.getPlayback().itemId!;
  runtime.remove(activeId);
  await flush();

  assert.equal(runtime.nowPlaying()?.ref.title, 'two');
});

test('clearing keeps what is playing', async () => {
  const { runtime } = harness();
  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });
  runtime.enqueue({ title: 'three' });
  await runtime.play();

  runtime.clear();

  assert.deepEqual(runtime.getQueue().map((i) => i.ref.title), ['one']);
  assert.equal(runtime.getPlayback().status, 'playing');
});

test('a snapshot tells an agent what each backend can do', async () => {
  const { runtime } = harness();
  const snapshot = runtime.getState();

  assert.equal(snapshot.adapters.length, 1);
  assert.equal(snapshot.adapters[0]!.capabilities.endOfTrack, 'event');
  assert.equal(snapshot.adapters[0]!.capabilities.seek, true);
});
