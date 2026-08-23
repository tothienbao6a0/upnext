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

test('every mutation bumps the version and announces itself', () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  const changes = collect(runtime, 'queue:changed');

  const a = runtime.enqueue({ title: 'a' });
  runtime.enqueue({ title: 'b' });
  runtime.move(a.id, { end: true });
  runtime.remove(a.id);

  assert.equal(changes.length, 4);
  const versions = changes.map((c) => c.version);
  assert.deepEqual(versions, [...versions].sort((x, y) => x - y));
  assert.equal(new Set(versions).size, versions.length, 'versions must be distinct');
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
