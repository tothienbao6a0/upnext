import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { FakeAdapter } from '../src/testing.js';
import { PERSISTENCE_VERSION } from '../src/persistence.js';
import { EVENT_CAPS, harness } from './fixtures.js';
import { flush } from './helpers.js';

function fresh() {
  return new Runtime({
    adapters: [new FakeAdapter({ capabilities: EVENT_CAPS })],
    scheduler: new ManualScheduler(),
  });
}

test('a queue survives a round trip through JSON', async () => {
  const { runtime } = harness();
  runtime.enqueue({ title: 'one', artist: 'A' });
  runtime.enqueue({ title: 'two', artist: 'B' });
  runtime.enqueue('something calmer');
  await runtime.play();

  // Through a string, because that is what a host will actually store.
  const saved = JSON.parse(JSON.stringify(runtime.serialize()));

  const reopened = fresh();
  reopened.restore(saved);

  assert.deepEqual(
    reopened.getQueue().map((i) => i.ref.title ?? i.intent),
    ['one', 'two', 'something calmer'],
  );
  assert.equal(reopened.getQueue()[2]!.intent, 'something calmer');
});

test('live bindings are dropped so entries rebind against today\'s adapters', async () => {
  const { runtime } = harness();
  runtime.enqueue({ title: 'one' });
  await runtime.play();

  const saved = runtime.serialize();
  assert.ok(saved.queue[0]!.binding, 'it was bound before saving');

  const reopened = fresh();
  reopened.restore(saved);

  const item = reopened.getQueue()[0]!;
  assert.equal(item.binding, undefined, 'a binding is a live handle, not state');
  assert.equal(item.status, 'unresolved', 'and nothing is playing after a restore');
});

test('history is kept as history', async () => {
  const { runtime, adapter } = harness();
  runtime.enqueue({ title: 'played' });
  runtime.enqueue({ title: 'upcoming' });
  await runtime.play();
  adapter.finish();
  await flush();

  const reopened = fresh();
  reopened.restore(runtime.serialize());

  assert.equal(reopened.getQueue()[0]!.status, 'ended');
  assert.equal(reopened.getQueue()[1]!.status, 'unresolved');
});

test('new entries cannot collide with restored ids', async () => {
  const { runtime } = harness();
  const a = runtime.enqueue({ title: 'one' });
  const b = runtime.enqueue({ title: 'two' });

  const reopened = fresh();
  reopened.restore(runtime.serialize());
  const added = reopened.enqueue({ title: 'three' });

  const ids = reopened.getQueue().map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, `ids must stay unique, got ${ids.join()}`);
  assert.ok(added.id !== a.id && added.id !== b.id);
});

test('repeat, shuffle and volume come back', async () => {
  const { runtime } = harness();
  runtime.setRepeat('all');
  runtime.setShuffle(true);
  await runtime.setVolume(0.4);

  const reopened = fresh();
  reopened.restore(runtime.serialize());

  assert.equal(reopened.repeat, 'all');
  assert.equal(reopened.shuffle, true);
  assert.equal(reopened.getPlayback().volume, 0.4);
});

test('the playhead is handed back so a host can resume mid-track', async () => {
  const { runtime, scheduler } = harness({ defaultDurationMs: 60_000 });
  runtime.enqueue({ title: 'one' });
  await runtime.play();
  scheduler.advance(12_000);

  const reopened = fresh();
  const { positionMs } = reopened.restore(runtime.serialize());

  assert.equal(positionMs, 12_000);
  assert.equal(reopened.getPlayback().status, 'idle', 'restoring never starts playback');
});

test('a payload from an unreadable version is refused, not guessed at', () => {
  const runtime = fresh();
  assert.throws(() => runtime.restore({ version: 999, queue: [] }), /expected version/);
  assert.throws(() => runtime.restore({}), /expected version/);
});

test('junk entries are dropped rather than failing the whole restore', () => {
  const runtime = fresh();
  runtime.restore({
    version: PERSISTENCE_VERSION,
    queue: [
      { id: 'q_0001', status: 'ready', ref: { title: 'good' }, addedAt: 0 },
      null,
      'nonsense',
      { status: 'ready', ref: { title: 'no id' } },
      { id: 'q_0002', status: 'ready' },
      { id: 'q_0003', status: 'ready', ref: { title: 'also good' }, addedAt: 0 },
    ],
    cursorId: 'q_0001',
    repeat: 'off',
    shuffle: false,
    positionMs: 0,
    volume: null,
  });

  assert.deepEqual(runtime.getQueue().map((i) => i.ref.title), ['good', 'also good']);
});

test('a cursor pointing at nothing is discarded', () => {
  const runtime = fresh();
  runtime.restore({
    version: PERSISTENCE_VERSION,
    queue: [{ id: 'q_0001', status: 'ready', ref: { title: 'one' }, addedAt: 0 }],
    cursorId: 'q_9999',
    repeat: 'off',
    shuffle: false,
    positionMs: 0,
    volume: null,
  });
  assert.equal(runtime.queue.cursorId, null);
});

test('a restored queue actually plays', async () => {
  const { runtime } = harness();
  runtime.enqueue({ title: 'one' });
  runtime.enqueue({ title: 'two' });

  const reopened = fresh();
  reopened.restore(JSON.parse(JSON.stringify(runtime.serialize())));
  await reopened.play();

  assert.equal(reopened.nowPlaying()?.ref.title, 'one');
  assert.equal(reopened.getPlayback().status, 'playing');
});
