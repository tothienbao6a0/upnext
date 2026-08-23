import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { FakeAdapter } from '../src/testing.js';
import type { Adapter } from '../src/types/index.js';
import { EVENT_CAPS } from './fixtures.js';
import { collect, flush } from './helpers.js';

/**
 * What happens when a backend lies, breaks, or never answers. All three look
 * identical from a listener's chair — nothing is playing — so the runtime has
 * to distinguish them and say which one it is.
 */

test('an adapter that claims a capability it cannot honour is rejected at registration', () => {
  const liar: Adapter = new FakeAdapter({ capabilities: { endOfTrack: 'event' } });
  // Not `delete`: these are prototype methods, so the instance must shadow them.
  liar.subscribe = undefined;

  assert.throws(
    () => new Runtime({ adapters: [liar], scheduler: new ManualScheduler() }),
    /endOfTrack 'event' but has no `subscribe`/,
  );
});

test('every inconsistency is reported at once, not one per attempt', () => {
  const liar: Adapter = new FakeAdapter({
    capabilities: { endOfTrack: 'poll', seek: true, search: true },
  });
  liar.poll = undefined;
  liar.seek = undefined;
  liar.search = undefined;

  try {
    new Runtime({ adapters: [liar], scheduler: new ManualScheduler() });
    assert.fail('should have thrown');
  } catch (err) {
    const message = (err as Error).message;
    assert.match(message, /`poll`/);
    assert.match(message, /`seek`/);
    assert.match(message, /`search`/);
  }
});

test('a backend whose init fails is not chosen, and says why', async () => {
  const broken: Adapter = new FakeAdapter({ id: 'broken', capabilities: EVENT_CAPS });
  broken.init = async () => {
    throw new Error('no speakers attached');
  };
  const working = new FakeAdapter({ id: 'working', capabilities: EVENT_CAPS });

  const runtime = new Runtime({ adapters: [broken, working], scheduler: new ManualScheduler() });
  await flush();

  const summary = runtime.getState().adapters;
  assert.equal(summary.find((a) => a.id === 'broken')?.available, false);
  assert.match(summary.find((a) => a.id === 'broken')?.error?.message ?? '', /no speakers/);
  assert.equal(summary.find((a) => a.id === 'working')?.available, true);

  runtime.enqueue({ title: 'anything' });
  await runtime.play();
  assert.equal(runtime.getPlayback().adapterId, 'working');
});

test('a backend that never answers gives way to one that does', async () => {
  const hung: Adapter = new FakeAdapter({ id: 'hung', capabilities: EVENT_CAPS });
  hung.resolve = () => new Promise(() => {}); // never settles
  const working = new FakeAdapter({ id: 'working', capabilities: EVENT_CAPS });

  const runtime = new Runtime({
    adapters: [hung, working],
    scheduler: new ManualScheduler(),
    timeoutMs: 20,
    lookahead: 0,
  });

  runtime.enqueue({ uri: 'hung:one' });
  await runtime.play();

  assert.equal(runtime.getPlayback().adapterId, 'working');
  assert.equal(runtime.getPlayback().status, 'playing');
});

test('a host resolver that never returns fails the entry instead of stopping the queue', async () => {
  const runtime = new Runtime({
    adapters: [new FakeAdapter({ capabilities: EVENT_CAPS })],
    scheduler: new ManualScheduler(),
    timeoutMs: 20,
    lookahead: 0,
    resolveIntent: () => new Promise(() => {}),
  });
  const failed = collect(runtime, 'item:failed');

  runtime.enqueue('something the host will never answer');
  runtime.enqueue({ title: 'plays fine' });
  await runtime.play();
  await flush();

  assert.equal(failed.length, 1);
  assert.equal(
    runtime.nowPlaying()?.ref.title,
    'plays fine',
    'one unanswerable entry must not stop everything behind it',
  );
});

test('timeouts can be switched off for hosts that would rather wait', async () => {
  const runtime = new Runtime({
    adapters: [new FakeAdapter({ capabilities: EVENT_CAPS })],
    scheduler: new ManualScheduler(),
    timeoutMs: null,
  });
  runtime.enqueue({ title: 'one' });
  await runtime.play();

  assert.equal(runtime.getPlayback().status, 'playing');
});

test('a backend that can neither report nor time the end of a track says so', async () => {
  const blind = new FakeAdapter({
    capabilities: { endOfTrack: 'none', position: 'none' },
  });
  // Resolve without a duration, so there is nothing to run a timer against.
  blind.resolve = async (ref) => ({ adapterId: blind.id, nativeUri: 'blind:1', ref });

  const runtime = new Runtime({ adapters: [blind], scheduler: new ManualScheduler() });
  const errors = collect(runtime, 'adapter:error');

  runtime.enqueue({ title: 'endless' });
  await runtime.play();

  assert.equal(errors.length, 1, 'a queue that cannot advance must not look like it is just slow');
  assert.equal(errors[0]!.error.code, 'no_duration');
});
