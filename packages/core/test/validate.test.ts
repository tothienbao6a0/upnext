import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateAdapter } from '../src/validate.js';
import { defaultCapabilities } from '../src/types/index.js';
import type { Adapter } from '../src/types/index.js';

/**
 * The gatekeeper's own tests.
 *
 * This is the code that stands between an adapter author and a backend that
 * compiles, registers, and then quietly never advances the queue. Every branch
 * of it is a specific mistake somebody will make, so every branch gets a case —
 * it had two.
 */

function adapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    id: 'test',
    capabilities: { ...defaultCapabilities },
    match: () => 1,
    resolve: async () => null,
    load: async () => {},
    play: async () => {},
    stop: async () => {},
    ...overrides,
  } as Adapter;
}

test('a minimal, honest adapter passes', () => {
  assert.doesNotThrow(() => validateAdapter(adapter()));
});

test('an adapter must be able to say who it is', () => {
  assert.throws(() => validateAdapter(adapter({ id: '' })), /`id` must be a non-empty string/);
  assert.throws(
    () => validateAdapter(adapter({ id: undefined as unknown as string })),
    /`id` must be a non-empty string/,
  );
});

test('each required method is named when it is missing', () => {
  for (const method of ['match', 'resolve', 'load', 'play', 'stop'] as const) {
    assert.throws(
      () => validateAdapter(adapter({ [method]: undefined })),
      new RegExp(`\`${method}\` is required`),
      `${method} was not reported`,
    );
  }
});

test('an adapter with no capabilities at all is refused', () => {
  assert.throws(
    () => validateAdapter(adapter({ capabilities: undefined as never })),
    /`capabilities` is required/,
  );
});

test("endOfTrack 'event' without subscribe would never advance", () => {
  assert.throws(
    () => validateAdapter(adapter({ capabilities: { ...defaultCapabilities, endOfTrack: 'event' } })),
    /endOfTrack 'event' but has no `subscribe`/,
  );
  assert.doesNotThrow(() =>
    validateAdapter(
      adapter({
        capabilities: { ...defaultCapabilities, endOfTrack: 'event' },
        subscribe: () => () => {},
      }),
    ),
  );
});

test("endOfTrack 'poll' without poll would never advance", () => {
  assert.throws(
    () => validateAdapter(adapter({ capabilities: { ...defaultCapabilities, endOfTrack: 'poll' } })),
    /endOfTrack 'poll' but has no `poll`/,
  );
});

test("position 'authoritative' needs some way for a position to arrive", () => {
  const caps = { ...defaultCapabilities, position: 'authoritative' as const };
  assert.throws(
    () => validateAdapter(adapter({ capabilities: caps })),
    /position 'authoritative' but has neither `poll` nor `subscribe`/,
  );

  // Either channel satisfies it — that is the point of naming both.
  assert.doesNotThrow(() =>
    validateAdapter(adapter({ capabilities: caps, poll: async () => ({ status: 'playing' }) })),
  );
  assert.doesNotThrow(() =>
    validateAdapter(adapter({ capabilities: caps, subscribe: () => () => {} })),
  );
});

test('externalControl needs a way to notice the takeover', () => {
  const caps = { ...defaultCapabilities, externalControl: true };
  assert.throws(
    () => validateAdapter(adapter({ capabilities: caps })),
    /externalControl but has neither `poll` nor `subscribe`/,
  );
  assert.doesNotThrow(() =>
    validateAdapter(adapter({ capabilities: caps, poll: async () => ({ status: 'playing' }) })),
  );
});

test('each gated capability names the method it needs', () => {
  const cases = [
    ['pause', 'pause'],
    ['seek', 'seek'],
    ['volume', 'setVolume'],
    ['search', 'search'],
  ] as const;

  for (const [capability, method] of cases) {
    assert.throws(
      () => validateAdapter(adapter({ capabilities: { ...defaultCapabilities, [capability]: true } })),
      new RegExp(`declares ${capability} but has no \`${method}\``),
      `${capability} was not reported`,
    );
    assert.doesNotThrow(() =>
      validateAdapter(
        adapter({
          capabilities: { ...defaultCapabilities, [capability]: true },
          [method]: async () => {},
        }),
      ),
    );
  }
});

test('every problem is reported at once, not one per attempt', () => {
  // An author fixing these one at a time, with a full rebuild between each, is
  // the experience this avoids.
  try {
    validateAdapter(
      adapter({
        id: '',
        capabilities: { ...defaultCapabilities, endOfTrack: 'poll', seek: true, volume: true },
        stop: undefined,
      }),
    );
    assert.fail('should have thrown');
  } catch (err) {
    const message = (err as Error).message;
    for (const expected of ['`id`', '`stop`', '`poll`', '`seek`', '`setVolume`']) {
      assert.ok(message.includes(expected), `${expected} missing from:\n${message}`);
    }
  }
});

test('the error carries the adapter id, so a host knows which one', () => {
  try {
    validateAdapter(adapter({ id: 'mine', capabilities: { ...defaultCapabilities, seek: true } }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal((err as { adapterId?: string }).adapterId, 'mine');
    assert.match((err as Error).message, /adapter mine is inconsistent/);
  }
});
