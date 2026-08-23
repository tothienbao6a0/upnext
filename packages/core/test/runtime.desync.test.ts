import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planReconciliation } from '../src/reconciler.js';
import { EVENT_CAPS, harness } from './fixtures.js';
import { collect, flush } from './helpers.js';
import type { Binding } from '../src/types/index.js';

const CURRENT: Binding = { adapterId: 'x', nativeUri: 'x:ours', ref: { title: 'ours' } };

test('a backend reporting nothing is idle, not hijacked', () => {
  assert.equal(planReconciliation('adopt', CURRENT, null).action, 'none');
});

test('a backend reporting what we asked for is not a desync', () => {
  assert.equal(planReconciliation('adopt', CURRENT, 'x:ours').action, 'none');
});

test('each policy produces the plan it promises', () => {
  const adopt = planReconciliation('adopt', CURRENT, 'x:theirs', { title: 'theirs' });
  assert.equal(adopt.action, 'adopted');
  assert.equal(adopt.adopt?.nativeUri, 'x:theirs');
  assert.equal(adopt.adopt?.ref.title, 'theirs');

  assert.equal(planReconciliation('correct', CURRENT, 'x:theirs').restore, CURRENT);
  assert.equal(planReconciliation('ignore', CURRENT, 'x:theirs').action, 'ignored');
});

test('the human wins a desync by default', async () => {
  const { runtime, adapter } = harness({
    capabilities: { ...EVENT_CAPS, externalControl: true },
  });
  const desyncs = collect(runtime, 'desync');

  runtime.enqueue({ title: 'ours' });
  await runtime.play();

  adapter.takeover('fake:theirs', { title: 'theirs', artist: 'a human chose this' });
  await flush();

  assert.equal(desyncs.length, 1);
  assert.equal(desyncs[0]!.action, 'adopted');
  assert.equal(runtime.nowPlaying()?.ref.title, 'theirs');
  assert.equal(runtime.getPlayback().status, 'playing');
});

test('what the human chose becomes a real queue entry after the one it replaced', async () => {
  const { runtime, adapter } = harness({
    capabilities: { ...EVENT_CAPS, externalControl: true },
  });
  runtime.enqueue({ title: 'ours' });
  runtime.enqueue({ title: 'later' });
  await runtime.play();

  adapter.takeover('fake:theirs', { title: 'theirs' });
  await flush();

  assert.deepEqual(
    runtime.getQueue().map((i) => i.ref.title),
    ['ours', 'theirs', 'later'],
  );
  assert.equal(runtime.getQueue()[0]!.status, 'ended');
});

test('after adopting, the queue carries on where the human left it', async () => {
  const { runtime, adapter } = harness({
    capabilities: { ...EVENT_CAPS, externalControl: true },
  });
  runtime.enqueue({ title: 'ours' });
  runtime.enqueue({ title: 'later' });
  await runtime.play();

  adapter.takeover('fake:theirs', { title: 'theirs' });
  await flush();
  adapter.finish();
  await flush();

  assert.equal(runtime.nowPlaying()?.ref.title, 'later');
});

test('policy `correct` puts the runtime back in charge', async () => {
  const { runtime, adapter } = harness(
    { capabilities: { ...EVENT_CAPS, externalControl: true } },
    { desyncPolicy: 'correct' },
  );

  runtime.enqueue({ title: 'ours' });
  await runtime.play();
  adapter.calls.length = 0;
  adapter.takeover('fake:theirs');
  await flush();

  assert.deepEqual(adapter.calls, ['load', 'play']);
  assert.equal(runtime.nowPlaying()?.ref.title, 'ours');
});

test('policy `ignore` reports and does nothing', async () => {
  const { runtime, adapter } = harness(
    { capabilities: { ...EVENT_CAPS, externalControl: true } },
    { desyncPolicy: 'ignore' },
  );
  const desyncs = collect(runtime, 'desync');

  runtime.enqueue({ title: 'ours' });
  await runtime.play();
  adapter.calls.length = 0;
  adapter.takeover('fake:theirs');
  await flush();

  assert.equal(desyncs[0]!.action, 'ignored');
  assert.deepEqual(adapter.calls, []);
  assert.equal(runtime.nowPlaying()?.ref.title, 'ours');
});
