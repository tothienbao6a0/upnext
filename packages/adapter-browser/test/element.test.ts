import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime, ManualScheduler } from 'upnext-core';
import type { AdapterEvent } from 'upnext-core';
import { MediaElementAdapter } from '../src/element.js';
import { FakeMediaElement } from './fake-element.js';

const flush = () => new Promise((r) => setImmediate(r));

function build() {
  const element = new FakeMediaElement();
  const adapter = new MediaElementAdapter({ element });
  return { element, adapter };
}

function collect(adapter: MediaElementAdapter): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return events;
}

test('loading points the element at the source and rewinds', async () => {
  const { element, adapter } = build();
  await adapter.load({ adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} });

  assert.equal(element.src, 'https://x.com/a.mp3');
  assert.ok(element.calls.includes('load'));
});

test('a start offset is applied before playback', async () => {
  const { element, adapter } = build();
  await adapter.load(
    { adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} },
    { startAtMs: 42_000 },
  );
  assert.equal(element.currentTime, 42);
});

test('the element ending is the end of the track', async () => {
  const { element, adapter } = build();
  const events = collect(adapter);
  await adapter.load({ adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} });
  await adapter.play();

  element.finish();
  assert.ok(events.some((e) => e.type === 'ended'));
});

test('position comes from the element, not a guess', async () => {
  const { element, adapter } = build();
  const events = collect(adapter);
  await adapter.load({ adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} });

  element.setDuration(180);
  element.tick(12.5);

  const last = events.filter((e) => e.type === 'position').at(-1);
  assert.deepEqual(last, { type: 'position', positionMs: 12_500, durationMs: 180_000 });
  assert.equal(adapter.capabilities.position, 'authoritative');
});

test('a duration of NaN or Infinity is not reported as a number', async () => {
  const { element, adapter } = build();
  const events = collect(adapter);
  await adapter.load({ adapterId: 'browser', nativeUri: 'https://x.com/live.m3u8', ref: {} });

  // A live stream: the element never knows how long it is.
  element.tick(5);
  const position = events.filter((e) => e.type === 'position').at(-1);
  assert.deepEqual(position, { type: 'position', positionMs: 5000 });
});

test('our own teardown is not reported as the listener pausing', async () => {
  const { adapter } = build();
  const events = collect(adapter);
  await adapter.load({ adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} });
  await adapter.play();
  events.length = 0;

  await adapter.stop();

  assert.deepEqual(
    events.filter((e) => e.type === 'status'),
    [],
    'stopping to play something else is not a pause',
  );
});

test('stopping releases the connection so a podcast stops downloading', async () => {
  const { element, adapter } = build();
  await adapter.load({ adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} });
  await adapter.play();
  await adapter.stop();

  assert.equal(element.src, '');
  assert.equal(element.paused, true);
});

test('a pause by the host is reported', async () => {
  const { adapter } = build();
  const events = collect(adapter);
  await adapter.load({ adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} });
  await adapter.play();
  await adapter.pause();

  assert.ok(events.some((e) => e.type === 'status' && e.status === 'paused'));
});

test('blocked autoplay fails loudly so the runtime can try another source', async () => {
  const { element, adapter } = build();
  element.blockAutoplay = true;
  await adapter.load({ adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} });

  await assert.rejects(() => adapter.play(), /NotAllowedError/);
});

test('a decode error is an event, not a crash', async () => {
  const { element, adapter } = build();
  const events = collect(adapter);
  await adapter.load({ adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} });

  element.fail();

  const error = events.find((e) => e.type === 'error');
  assert.ok(error && 'message' in error && error.message.includes('https://x.com/a.mp3'));
});

test('constructing the adapter never touches the element', () => {
  let built = 0;
  const adapter = new MediaElementAdapter({
    element: () => {
      built++;
      return new FakeMediaElement();
    },
  });

  assert.equal(built, 0, 'a host can build its queue before it has a document');
  assert.equal(adapter.match({ uri: 'https://x.com/a.mp3' }), 1, 'and still score refs');
});

test('listeners are detached when the last subscriber leaves', async () => {
  const { element, adapter } = build();
  const off = adapter.subscribe(() => {});
  assert.ok(element.listenerCount > 0);

  off();
  assert.equal(element.listenerCount, 0, 'no leaked handlers on a discarded element');
});

test('the runtime drives it end to end', async () => {
  const element = new FakeMediaElement();
  const runtime = new Runtime({
    adapters: [new MediaElementAdapter({ element })],
    scheduler: new ManualScheduler(),
  });

  runtime.enqueue('https://x.com/first.mp3');
  runtime.enqueue('https://x.com/second.mp3');
  await runtime.play();

  assert.equal(element.src, 'https://x.com/first.mp3');
  assert.equal(runtime.getPlayback().status, 'playing');
  assert.equal(runtime.can('seek'), true);

  element.finish();
  await flush();

  assert.equal(element.src, 'https://x.com/second.mp3', 'the queue advanced on its own');
  await runtime.dispose();
});
