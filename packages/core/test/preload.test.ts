import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { FakeAdapter } from '../src/testing.js';
import { collect, flush } from './helpers.js';

/**
 * Whether the runtime hands a backend the next item, and when.
 *
 * The browser adapter proves the *effect* — no gap between tracks. These cover
 * the decision: only to a backend that asked for it, only when the next entry
 * is already bound to that same backend, once per item, and never a stale one.
 * Getting any of those wrong wastes a fetch or plays the wrong thing.
 */

const CAPS = { endOfTrack: 'event', position: 'estimated', preload: true } as const;

function build(overrides: Record<string, unknown> = {}) {
  const adapter = new FakeAdapter({ capabilities: CAPS, ...overrides });
  const runtime = new Runtime({
    adapters: [adapter],
    scheduler: new ManualScheduler(),
    lookahead: 2,
  });
  return { adapter, runtime };
}

test('the next item is offered as soon as one starts playing', async () => {
  const { adapter, runtime } = build();
  runtime.enqueue({ uri: 'fake:one' });
  runtime.enqueue({ uri: 'fake:two' });

  await runtime.play();
  await flush();

  assert.deepEqual(adapter.preloaded, ['fake:two'], 'a whole track of time to get ready');
  await runtime.dispose();
});

test('a backend that did not ask for it is never offered anything', async () => {
  const { adapter, runtime } = build({ capabilities: { endOfTrack: 'event', preload: false } });
  runtime.enqueue({ uri: 'fake:one' });
  runtime.enqueue({ uri: 'fake:two' });

  await runtime.play();
  await flush();

  assert.deepEqual(adapter.preloaded, []);
  assert.ok(!adapter.calls.includes('preload'));
  await runtime.dispose();
});

test('nothing is offered across backends', async () => {
  // A media element cannot buffer a Spotify track. Offering it would be
  // meaningless work at best and a wrong assumption at worst.
  const scheduler = new ManualScheduler();
  const a = new FakeAdapter({ id: 'a', capabilities: CAPS });
  const b = new FakeAdapter({ id: 'b', capabilities: CAPS });
  const runtime = new Runtime({ adapters: [a, b], scheduler, lookahead: 2 });

  runtime.enqueue({ uri: 'a:one' });
  runtime.enqueue({ uri: 'b:two' });
  await runtime.play();
  await flush();

  assert.deepEqual(a.preloaded, [], 'a must not be asked to prepare b\'s item');
  assert.deepEqual(b.preloaded, []);
  await runtime.dispose();
});

test('the same item is not offered twice', async () => {
  const { adapter, runtime } = build();
  runtime.enqueue({ uri: 'fake:one' });
  runtime.enqueue({ uri: 'fake:two' });
  await runtime.play();
  await flush();

  // Anything that pokes the queue re-evaluates what is next; re-offering the
  // same thing would throw away a buffer that is already filling.
  runtime.enqueue({ uri: 'fake:three' });
  await flush();

  assert.deepEqual(adapter.preloaded, ['fake:two']);
  await runtime.dispose();
});

test('a queue that changes re-offers whatever is now next', async () => {
  const { adapter, runtime } = build();
  runtime.enqueue({ uri: 'fake:one' });
  runtime.enqueue({ uri: 'fake:two' });
  await runtime.play();
  await flush();
  assert.deepEqual(adapter.preloaded, ['fake:two']);

  runtime.enqueue({ uri: 'fake:urgent' }, { next: true });
  await flush();

  assert.deepEqual(adapter.preloaded, ['fake:two', 'fake:urgent']);
  await runtime.dispose();
});

test('starting a different track forgets what was prepared', async () => {
  const { adapter, runtime } = build();
  runtime.enqueue({ uri: 'fake:one' });
  runtime.enqueue({ uri: 'fake:two' });
  runtime.enqueue({ uri: 'fake:three' });
  await runtime.play();
  await flush();
  assert.deepEqual(adapter.preloaded, ['fake:two']);

  adapter.finish();
  await flush();

  // Now playing two, so three is next — and it must be offered even though
  // something was already offered under the previous track.
  assert.deepEqual(adapter.preloaded, ['fake:two', 'fake:three']);
  await runtime.dispose();
});

test('nothing is offered when there is nothing next', async () => {
  const { adapter, runtime } = build();
  runtime.enqueue({ uri: 'fake:only' });
  await runtime.play();
  await flush();

  assert.deepEqual(adapter.preloaded, []);
  await runtime.dispose();
});

test('an unbound entry is not offered, and is offered once it binds', async () => {
  const { adapter, runtime } = build({ capabilities: { ...CAPS, search: true } });
  runtime.enqueue({ uri: 'fake:one' });
  await runtime.play();
  await flush();
  assert.deepEqual(adapter.preloaded, [], 'nothing to offer yet');

  // An entry cannot be offered before anyone knows which backend it belongs to.
  runtime.enqueue({ uri: 'fake:later' });
  await flush();
  assert.deepEqual(adapter.preloaded, ['fake:later']);
  await runtime.dispose();
});

test('a backend that cannot prepare still plays, and says why', async () => {
  const { adapter, runtime } = build({ failOnPreload: true });
  const errors = collect(runtime, 'error');

  runtime.enqueue({ uri: 'fake:one' });
  runtime.enqueue({ uri: 'fake:two' });
  await runtime.play();
  await flush();

  assert.match(errors[0]?.while ?? '', /preparing fake:two/);

  // The point: a failed preparation costs the gap, not the track.
  adapter.finish();
  await flush();
  assert.equal(runtime.nowPlaying()?.ref.uri, 'fake:two');
  assert.equal(runtime.getPlayback().status, 'playing');
  await runtime.dispose();
});

test('stopping forgets what was prepared', async () => {
  const { adapter, runtime } = build();
  runtime.enqueue({ uri: 'fake:one' });
  runtime.enqueue({ uri: 'fake:two' });
  await runtime.play();
  await flush();
  assert.deepEqual(adapter.preloaded, ['fake:two']);

  await runtime.stop();
  await runtime.play();
  await flush();

  // Offered again after restarting, rather than suppressed by a stale record.
  assert.deepEqual(adapter.preloaded, ['fake:two', 'fake:two']);
  await runtime.dispose();
});
