import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../src/registry.js';
import { FakeAdapter } from '../src/testing.js';
import type { Adapter, AdapterEvent, SerializedError } from '../src/types/index.js';

const flush = () => new Promise((r) => setImmediate(r));

function build() {
  const events: Array<{ id: string; event: AdapterEvent }> = [];
  const errors: Array<{ id: string; error: SerializedError }> = [];
  const registry = new AdapterRegistry({
    onEvent: (adapter, event) => events.push({ id: adapter.id, event }),
    onError: (adapterId, error) => errors.push({ id: adapterId, error }),
  });
  return { registry, events, errors };
}

test('an adapter is registered, listed, and retrievable by id', () => {
  const { registry } = build();
  const adapter = new FakeAdapter({ id: 'one', capabilities: { endOfTrack: 'event' } });
  registry.add(adapter);

  assert.deepEqual(registry.list().map((a) => a.id), ['one']);
  assert.equal(registry.get('one'), adapter);
  assert.equal(registry.get('nope'), undefined);
});

test('registering the same id twice is refused', () => {
  const { registry } = build();
  registry.add(new FakeAdapter({ id: 'one', capabilities: { endOfTrack: 'event' } }));
  assert.throws(
    () => registry.add(new FakeAdapter({ id: 'one', capabilities: { endOfTrack: 'event' } })),
    /already registered/,
  );
});

test('events from a subscribing adapter are routed with their source', () => {
  const { registry, events } = build();
  const adapter = new FakeAdapter({ id: 'one', capabilities: { endOfTrack: 'event' } });
  registry.add(adapter);

  adapter.emit({ type: 'ended' });
  assert.deepEqual(events, [{ id: 'one', event: { type: 'ended' } }]);
});

test('an adapter with no subscribe is fine, it just never pushes', () => {
  const { registry } = build();
  const adapter: Adapter = new FakeAdapter({ id: 'quiet', capabilities: { endOfTrack: 'none' } });
  adapter.subscribe = undefined;
  assert.doesNotThrow(() => registry.add(adapter));
});

test('an adapter that fails to start is reported and taken out of the running', async () => {
  const { registry, errors } = build();
  const broken: Adapter = new FakeAdapter({ id: 'broken', capabilities: { endOfTrack: 'event' } });
  broken.init = async () => {
    throw new Error('no speakers attached');
  };
  const working = new FakeAdapter({ id: 'working', capabilities: { endOfTrack: 'event' } });

  registry.add(broken);
  registry.add(working);
  await flush();

  assert.match(errors[0]?.error.message ?? '', /no speakers/);
  assert.match(registry.failure('broken')?.message ?? '', /no speakers/);
  assert.equal(registry.failure('working'), undefined);

  // Still listed — a host wants to show it and say why — but not selectable.
  assert.deepEqual(registry.list().map((a) => a.id).sort(), ['broken', 'working']);
  assert.deepEqual(registry.available().map((a) => a.id), ['working']);
});

test('removing an adapter unsubscribes it, disposes it, and clears its failure', async () => {
  const { registry, events } = build();
  const broken: Adapter = new FakeAdapter({ id: 'broken', capabilities: { endOfTrack: 'event' } });
  broken.init = async () => {
    throw new Error('nope');
  };
  registry.add(broken);
  await flush();
  assert.ok(registry.failure('broken'));

  const removed = await registry.remove('broken');
  assert.equal(removed?.id, 'broken');
  assert.equal(registry.get('broken'), undefined);
  assert.equal(registry.failure('broken'), undefined);

  (broken as FakeAdapter).emit({ type: 'ended' });
  assert.deepEqual(events, [], 'a removed adapter must not still be heard');
});

test('removing something that was never there is not an error', async () => {
  const { registry } = build();
  assert.equal(await registry.remove('ghost'), undefined);
});

test('a backend that refuses to stop is reported, not thrown', async () => {
  const { registry, errors } = build();
  const stubborn = new FakeAdapter({ id: 'stubborn', capabilities: { endOfTrack: 'event' } });
  stubborn.stop = async () => {
    throw new Error('will not stop');
  };

  await registry.stop(stubborn);
  assert.match(errors.at(-1)?.error.message ?? '', /will not stop/);
});

test('disposeAll empties the registry and silences everything in it', async () => {
  const { registry, events } = build();
  const a = new FakeAdapter({ id: 'a', capabilities: { endOfTrack: 'event' } });
  const b = new FakeAdapter({ id: 'b', capabilities: { endOfTrack: 'event' } });
  registry.add(a);
  registry.add(b);

  await registry.disposeAll();

  assert.deepEqual(registry.list(), []);
  a.emit({ type: 'ended' });
  b.emit({ type: 'ended' });
  assert.deepEqual(events, []);
});

test('one adapter failing to dispose does not block the others', async () => {
  const { registry } = build();
  const bad: Adapter = new FakeAdapter({ id: 'bad', capabilities: { endOfTrack: 'event' } });
  bad.dispose = async () => {
    throw new Error('dispose exploded');
  };
  registry.add(bad);
  registry.add(new FakeAdapter({ id: 'good', capabilities: { endOfTrack: 'event' } }));

  await assert.doesNotReject(() => registry.disposeAll());
  assert.deepEqual(registry.list(), []);
});
