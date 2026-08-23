import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { FakeAdapter } from '../src/testing.js';
import { EVENT_CAPS, harness } from './fixtures.js';
import { collect, deferred, flush } from './helpers.js';

test('falls back to another source when the preferred one cannot play it', async () => {
  const broken = new FakeAdapter({ id: 'broken', capabilities: EVENT_CAPS, failOnLoad: true });
  const working = new FakeAdapter({ id: 'working', capabilities: EVENT_CAPS });
  const runtime = new Runtime({
    adapters: [broken, working],
    scheduler: new ManualScheduler(),
  });

  runtime.enqueue({ title: 'Bad Habit', artist: 'Steve Lacy' });
  await runtime.play();

  assert.equal(runtime.getPlayback().adapterId, 'working');
  assert.equal(runtime.nowPlaying()?.status, 'active');
  assert.deepEqual(runtime.nowPlaying()?.attempted, ['broken', 'working']);
});

test('an adapter that resolves nothing yields to the next one', async () => {
  const empty = new FakeAdapter({ id: 'empty', capabilities: EVENT_CAPS, failOnResolve: true });
  const stocked = new FakeAdapter({ id: 'stocked', capabilities: EVENT_CAPS });
  const runtime = new Runtime({ adapters: [empty, stocked], scheduler: new ManualScheduler() });

  runtime.enqueue({ title: 'anything' });
  await runtime.play();

  assert.equal(runtime.getPlayback().adapterId, 'stocked');
});

test('a dead entry does not stall the queue', async () => {
  const { runtime } = harness({ handles: (ref) => ref.title !== 'unplayable' });
  const failed = collect(runtime, 'item:failed');

  runtime.enqueue({ title: 'unplayable' });
  runtime.enqueue({ title: 'fine' });
  await runtime.play();
  await flush();

  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.error.code, 'no_adapter');
  assert.equal(runtime.nowPlaying()?.ref.title, 'fine');
});

test('refuses a resolution that is not actually the requested song', async () => {
  const liar = new FakeAdapter({ id: 'liar', capabilities: EVENT_CAPS });
  liar.resolve = async () => ({
    adapterId: 'liar',
    nativeUri: 'liar:1',
    ref: { title: 'Something Else Entirely', artist: 'A Different Band' },
  });

  const runtime = new Runtime({ adapters: [liar], scheduler: new ManualScheduler() });
  const failed = collect(runtime, 'item:failed');

  runtime.enqueue({ title: 'Bad Habit', artist: 'Steve Lacy' });
  await runtime.play();
  await flush();

  assert.equal(failed.length, 1);
  assert.match(failed[0]!.error.message, /poor match/);
});

test('a bare locator is trusted even though there is no metadata to check', async () => {
  const { runtime } = harness();
  runtime.enqueue('file:///tmp/voice-memo.m4a');
  await runtime.play();

  assert.equal(runtime.getPlayback().status, 'playing');
  assert.equal(runtime.nowPlaying()?.ref.uri, 'file:///tmp/voice-memo.m4a');
});

test('skipping mid-load does not race two tracks onto the output', async () => {
  const { runtime, adapter } = harness();
  const gate = deferred();
  const load = adapter.load.bind(adapter);
  adapter.load = async (binding) => {
    if (binding.ref.title === 'slow') await gate.promise;
    return load(binding);
  };

  runtime.enqueue({ title: 'slow' });
  runtime.enqueue({ title: 'fast' });

  const slow = runtime.play();
  await flush();
  await runtime.next();
  gate.resolve();
  await slow;
  await flush();

  assert.equal(runtime.nowPlaying()?.ref.title, 'fast');
  assert.equal(runtime.getPlayback().itemId, runtime.getQueue()[1]!.id);
});

test('search fans out across adapters that support it', async () => {
  const scheduler = new ManualScheduler();
  const a = new FakeAdapter({
    id: 'a',
    capabilities: { ...EVENT_CAPS, search: true },
    catalogue: [{ title: 'Nights', artist: 'Frank Ocean', uri: 'a:1' }],
  });
  const b = new FakeAdapter({
    id: 'b',
    capabilities: { ...EVENT_CAPS, search: false },
    catalogue: [{ title: 'Nights', artist: 'Frank Ocean', uri: 'b:1' }],
  });
  const runtime = new Runtime({ adapters: [a, b], scheduler });

  const results = await runtime.search('nights');
  assert.deepEqual(results.map((r) => r.adapterId), ['a']);
});
