import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime, ManualScheduler } from 'upnext-core';
import { RemoteMediaAdapter, serveMediaElement, type Channel } from '../src/remote.js';
import { FakeMediaElement } from './fake-element.js';

const flush = () => new Promise((r) => setImmediate(r));

/**
 * A boundary made of two functions.
 *
 * In an Electron app this is `ipcMain`/`ipcRenderer`; here it is a pair of
 * in-memory channels that hand messages to each other asynchronously, because a
 * real boundary is never synchronous and a test that pretends otherwise would
 * hide every ordering bug there is.
 */
function pair(): { near: Channel; far: Channel } {
  const nearListeners = new Set<(m: unknown) => void>();
  const farListeners = new Set<(m: unknown) => void>();
  const deliver = (to: Set<(m: unknown) => void>, message: unknown) => {
    queueMicrotask(() => {
      for (const listener of [...to]) listener(message);
    });
  };
  return {
    near: {
      send: (m) => deliver(farListeners, m),
      subscribe: (l) => (nearListeners.add(l), () => nearListeners.delete(l)),
    },
    far: {
      send: (m) => deliver(nearListeners, m),
      subscribe: (l) => (farListeners.add(l), () => farListeners.delete(l)),
    },
  };
}

function wire() {
  const { near, far } = pair();
  const element = new FakeMediaElement();
  const stopServing = serveMediaElement(element, far);
  const adapter = new RemoteMediaAdapter({ channel: near, requestTimeoutMs: 500 });
  return { element, adapter, stopServing };
}

test('commands cross the boundary and reach the element', async () => {
  const { element, adapter, stopServing } = wire();
  await adapter.init();

  await adapter.load({ adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} });
  await adapter.play();

  assert.equal(element.src, 'https://x.com/a.mp3');
  assert.equal(element.paused, false);

  await adapter.seek(30_000);
  assert.equal(element.currentTime, 30);

  await adapter.setVolume(0.25);
  assert.equal(element.volume, 0.25);

  stopServing();
  await adapter.dispose();
});

test('events cross back', async () => {
  const { element, adapter, stopServing } = wire();
  await adapter.init();
  const events: string[] = [];
  adapter.subscribe((e) => events.push(e.type));

  await adapter.load({ adapterId: 'browser', nativeUri: 'https://x.com/a.mp3', ref: {} });
  element.setDuration(120);
  element.finish();
  await flush();

  assert.ok(events.includes('ended'));
  assert.ok(events.includes('position'));

  stopServing();
  await adapter.dispose();
});

test('both sides agree on capabilities, because both sides are the same adapter', async () => {
  const { adapter, stopServing } = wire();
  assert.equal(adapter.capabilities.endOfTrack, 'event');
  assert.equal(adapter.capabilities.position, 'authoritative');
  assert.equal(adapter.capabilities.externalControl, false);
  stopServing();
  await adapter.dispose();
});

test('match never crosses the boundary', async () => {
  const { adapter, stopServing } = wire();
  // No init, no channel traffic — scoring is local by contract.
  assert.equal(adapter.match({ uri: 'https://x.com/a.mp3' }), 1);
  assert.equal(adapter.match({ uri: 'https://youtube.com/watch?v=x' }), 0);
  stopServing();
  await adapter.dispose();
});

test('a malformed command is an error reply, not a crash in the renderer', async () => {
  const { near, far } = pair();
  const element = new FakeMediaElement();
  const stopServing = serveMediaElement(element, far);

  const replies: unknown[] = [];
  near.subscribe((m) => replies.push(m));
  near.send({ id: 1, method: 'seek', params: { positionMs: 'soon' } });
  await flush();
  await flush();

  assert.deepEqual(replies, [{ id: 1, error: 'seek requires a finite positionMs' }]);
  stopServing();
});

test('a far side that never answers times out rather than hanging the queue', async () => {
  const silent: Channel = { send: () => {}, subscribe: () => () => {} };
  const adapter = new RemoteMediaAdapter({ channel: silent, requestTimeoutMs: 20 });
  await adapter.init();

  await assert.rejects(() => adapter.play(), /timed out after 20ms/);
  await adapter.dispose();
});

test('the runtime drives an element across a boundary end to end', async () => {
  const { element, adapter, stopServing } = wire();
  const runtime = new Runtime({ adapters: [adapter], scheduler: new ManualScheduler() });

  runtime.enqueue('https://x.com/first.mp3');
  runtime.enqueue('https://x.com/second.mp3');
  await runtime.play();

  assert.equal(element.src, 'https://x.com/first.mp3');

  element.finish();
  await flush();
  await flush();

  assert.equal(element.src, 'https://x.com/second.mp3');

  stopServing();
  await runtime.dispose();
});
