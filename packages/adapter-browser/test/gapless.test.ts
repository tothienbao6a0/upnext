import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime, ManualScheduler } from 'upnext-core';
import { MediaElementAdapter } from '../src/element.js';
import { FakeMediaElement } from './fake-element.js';

const flush = () => new Promise((r) => setImmediate(r));

/**
 * The gap, and its absence.
 *
 * "Gapless" is not a feeling here, it is a claim with a test: the next track's
 * buffer must be filled *before* the current one ends. If the source is only
 * set after `ended` fires, there is a fetch in between and the listener hears
 * it — which is exactly what these assert against.
 */

function build() {
  const main = new FakeMediaElement();
  const spare = new FakeMediaElement();
  const adapter = new MediaElementAdapter({ element: main, spare });
  const runtime = new Runtime({
    adapters: [adapter],
    scheduler: new ManualScheduler(),
    lookahead: 2,
  });
  return { main, spare, adapter, runtime };
}

test('preload is declared only when there is somewhere to buffer', () => {
  const withSpare = new MediaElementAdapter({
    element: new FakeMediaElement(),
    spare: new FakeMediaElement(),
  });
  const without = new MediaElementAdapter({ element: new FakeMediaElement() });

  assert.equal(withSpare.capabilities.preload, true);
  assert.equal(without.capabilities.preload, false, 'a capability it cannot honour');
  assert.equal(typeof without.preload, 'function', 'the method exists either way');
});

test('the next track is buffered while the current one is still playing', async () => {
  const { main, spare, runtime } = build();
  runtime.enqueue('https://x.com/first.mp3');
  runtime.enqueue('https://x.com/second.mp3');

  await runtime.play();
  await flush();

  assert.equal(main.src, 'https://x.com/first.mp3', 'playing the first');
  assert.equal(spare.src, 'https://x.com/second.mp3', 'and the second is already loading');
  assert.ok(spare.calls.includes('load'), 'the spare was told to buffer');
  await runtime.dispose();
});

test('the switch at the end uses the buffer instead of fetching', async () => {
  const { main, spare, runtime } = build();
  runtime.enqueue('https://x.com/first.mp3');
  runtime.enqueue('https://x.com/second.mp3');
  await runtime.play();
  await flush();

  const bufferedElement = spare;
  bufferedElement.calls.length = 0;

  main.finish();
  await flush();

  // The element that was buffering is now the one playing, and it was never
  // asked to load again — the buffer survived the transition.
  assert.equal(runtime.getPlayback().status, 'playing');
  assert.equal(bufferedElement.src, 'https://x.com/second.mp3');
  assert.ok(
    !bufferedElement.calls.includes('load'),
    `re-fetching would defeat the point: ${bufferedElement.calls.join()}`,
  );
  assert.ok(bufferedElement.calls.includes('play'));
  await runtime.dispose();
});

test('the finished track is released rather than left holding a connection', async () => {
  const { main, runtime } = build();
  runtime.enqueue('https://x.com/first.mp3');
  runtime.enqueue('https://x.com/second.mp3');
  await runtime.play();
  await flush();

  main.finish();
  await flush();

  assert.equal(main.src, '', 'the outgoing element should let go');
  await runtime.dispose();
});

test('a queue that changes re-buffers the new next track', async () => {
  const { spare, runtime } = build();
  runtime.enqueue('https://x.com/first.mp3');
  const second = runtime.enqueue('https://x.com/second.mp3');
  await runtime.play();
  await flush();
  assert.equal(spare.src, 'https://x.com/second.mp3');

  // Somebody jumps something else in front.
  runtime.enqueue('https://x.com/urgent.mp3', { next: true });
  await flush();

  assert.equal(spare.src, 'https://x.com/urgent.mp3', 'the buffer follows the queue');
  void second;
  await runtime.dispose();
});

test('a preloaded track that never plays costs nothing', async () => {
  const { spare, runtime } = build();
  runtime.enqueue('https://x.com/first.mp3');
  const doomed = runtime.enqueue('https://x.com/second.mp3');
  await runtime.play();
  await flush();
  assert.equal(spare.src, 'https://x.com/second.mp3');

  runtime.remove(doomed.id);
  await flush();

  // Nothing left to prepare. The stale buffer is simply never used, and the
  // adapter is not left in a state that breaks the next real load.
  runtime.enqueue('https://x.com/third.mp3');
  await flush();
  assert.equal(spare.src, 'https://x.com/third.mp3');
  await runtime.dispose();
});

test('without a spare it still plays, just with the gap', async () => {
  const main = new FakeMediaElement();
  const runtime = new Runtime({
    adapters: [new MediaElementAdapter({ element: main })],
    scheduler: new ManualScheduler(),
  });
  runtime.enqueue('https://x.com/first.mp3');
  runtime.enqueue('https://x.com/second.mp3');
  await runtime.play();

  main.finish();
  await flush();

  assert.equal(main.src, 'https://x.com/second.mp3', 'the queue still advances');
  await runtime.dispose();
});

test('a start offset takes the ordinary path, not the buffer', async () => {
  const main = new FakeMediaElement();
  const spare = new FakeMediaElement();
  const adapter = new MediaElementAdapter({ element: main, spare });

  await adapter.preload({ adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} });
  await adapter.load(
    { adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} },
    { startAtMs: 30_000 },
  );

  // Seeking discards the buffered position anyway, so the simpler path wins.
  assert.equal(main.src, 'https://x.com/a.mp3');
  assert.equal(main.currentTime, 30);
  await adapter.dispose();
});

test('disposing releases the spare too', async () => {
  const { spare, runtime } = build();
  runtime.enqueue('https://x.com/first.mp3');
  runtime.enqueue('https://x.com/second.mp3');
  await runtime.play();
  await flush();
  assert.equal(spare.src, 'https://x.com/second.mp3');

  await runtime.dispose();
  assert.equal(spare.src, '', 'a spare left holding a source keeps buffering');
});
