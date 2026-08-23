import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { FakeAdapter } from '../src/testing.js';
import { EVENT_CAPS } from './fixtures.js';
import { deferred, flush } from './helpers.js';

/**
 * What happens to a backend the runtime started and then changed its mind
 * about. The generation counter stops the runtime from *tracking* stale work;
 * these cover the other half, which is that the stale work must also be stopped
 * rather than left running.
 */

test('a bind cancelled after playback started does not leave audio running', async () => {
  const slow = new FakeAdapter({ id: 'slow', capabilities: EVENT_CAPS });
  const fast = new FakeAdapter({ id: 'fast', capabilities: EVENT_CAPS });

  const gate = deferred();
  const play = slow.play.bind(slow);
  slow.play = async () => {
    await play();
    await gate.promise;
  };

  const runtime = new Runtime({
    adapters: [slow, fast],
    scheduler: new ManualScheduler(),
    lookahead: 0,
  });

  runtime.enqueue({ uri: 'slow:one' });
  runtime.enqueue({ uri: 'fast:two' });

  const starting = runtime.play();
  await flush();

  // Skip while the first backend is mid-play. The runtime moves on.
  await runtime.next();
  gate.resolve();
  await starting;
  await flush();

  assert.equal(fast.status, 'playing');
  assert.equal(slow.status, 'idle', 'the abandoned backend must be stopped, not left playing');
});

test('a backend that loaded but failed to play is stopped before the next is tried', async () => {
  const broken = new FakeAdapter({ id: 'broken', capabilities: EVENT_CAPS });
  const working = new FakeAdapter({ id: 'working', capabilities: EVENT_CAPS });
  broken.play = async () => {
    throw new Error('speaker fell off');
  };

  const runtime = new Runtime({
    adapters: [broken, working],
    scheduler: new ManualScheduler(),
    lookahead: 0,
  });

  runtime.enqueue({ title: 'anything' });
  await runtime.play();

  assert.equal(runtime.getPlayback().adapterId, 'working');
  assert.ok(broken.calls.includes('stop'), 'a half-loaded backend must be cleaned up');
});
