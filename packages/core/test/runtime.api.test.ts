import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { FakeAdapter } from '../src/testing.js';
import { EVENT_CAPS, harness } from './fixtures.js';
import { flush } from './helpers.js';

/**
 * Guarantees about the surface itself rather than about playback: that an agent
 * can find out what it is allowed to do, and that nothing it is handed can be
 * used to corrupt the runtime.
 */

test('playback state carries the live backend capabilities inline', async () => {
  const { runtime } = harness();
  assert.equal(runtime.getPlayback().capabilities, null, 'nothing loaded, nothing possible');

  runtime.enqueue({ title: 'one' });
  await runtime.play();

  const caps = runtime.getPlayback().capabilities;
  assert.ok(caps, 'a loaded backend must publish what it can do');
  assert.equal(caps.seek, true);
  assert.equal(caps.endOfTrack, 'event');
  assert.equal(
    caps.position,
    'estimated',
    'how much to trust positionMs comes from the same place',
  );
});

test('can() answers without a join against the adapter list', async () => {
  const { runtime } = harness({ capabilities: { ...EVENT_CAPS, seek: false } });
  assert.equal(runtime.can('pause'), false, 'nothing loaded can do nothing');

  runtime.enqueue({ title: 'one' });
  await runtime.play();

  assert.equal(runtime.can('pause'), true);
  assert.equal(runtime.can('seek'), false);
});

test('can() and the thrown error agree', async () => {
  const { runtime } = harness({ capabilities: { ...EVENT_CAPS, seek: false } });
  runtime.enqueue({ title: 'one' });
  await runtime.play();

  assert.equal(runtime.can('seek'), false);
  await assert.rejects(() => runtime.seek(500), /cannot seek/);
});

test('the exposed queue has no way to mutate it', () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  runtime.enqueue({ title: 'a' });

  const view = runtime.queue as unknown as Record<string, unknown>;
  for (const method of ['insert', 'move', 'remove', 'update', 'clear']) {
    assert.equal(view[method], undefined, `${method} must not be reachable`);
  }
  assert.ok(Object.isFrozen(runtime.queue), 'and it cannot be given one');
});

test('entries handed out are copies, so a consumer cannot corrupt the queue', () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  const created = runtime.enqueue({ title: 'a' });

  created.status = 'failed';
  runtime.queue.get(created.id)!.ref.title = 'tampered';
  runtime.getQueue()[0]!.status = 'ended';
  runtime.getState().queue[0]!.ref.title = 'also tampered';

  const actual = runtime.queue.get(created.id)!;
  assert.equal(actual.status, 'unresolved');
  assert.equal(actual.ref.title, 'a');
});

test('event payloads are copies too', async () => {
  const { runtime } = harness();
  runtime.on('item:started', ({ item }) => {
    item.status = 'failed';
    item.ref.title = 'tampered';
  });

  runtime.enqueue({ title: 'one' });
  await runtime.play();
  await flush();

  assert.equal(runtime.nowPlaying()?.status, 'active');
  assert.equal(runtime.nowPlaying()?.ref.title, 'one');
});

test('entries queued before any adapter exists are prepared once one arrives', async () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler(), lookahead: 2 });
  const warnings: string[] = [];
  runtime.on('item:unresolvable', ({ error }) => warnings.push(error.code));

  const item = runtime.enqueue({ title: 'queued early' });
  await flush();
  assert.deepEqual(warnings, [], 'an unwired host is not a broken entry');
  assert.equal(runtime.queue.get(item.id)?.status, 'unresolved');

  runtime.addAdapter(new FakeAdapter({ capabilities: EVENT_CAPS }));
  await flush();

  assert.equal(runtime.queue.get(item.id)?.status, 'ready');
});

test('seeking with nothing loaded is an error, not a silent success', async () => {
  const { runtime } = harness();
  await assert.rejects(() => runtime.seek(1000), /nothing is loaded/);
});

test('pause and resume are no-ops when already in that state', async () => {
  const { runtime, adapter } = harness();
  await runtime.pause();
  await runtime.resume();

  runtime.enqueue({ title: 'one' });
  await runtime.play();
  adapter.calls.length = 0;

  await runtime.resume(); // already playing
  assert.deepEqual(adapter.calls, [], 'resuming what plays must not touch the backend');

  await runtime.pause();
  await runtime.pause(); // already paused
  assert.deepEqual(adapter.calls, ['pause']);
});
