import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeLocator } from '../src/input.js';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';

/**
 * Whether a bare string is something to play or something to look up.
 *
 * The whole convenience of `enqueue("…")` rests on this, and getting it wrong
 * is silent: a title read as a locator becomes an entry no adapter can bind,
 * which surfaces as "that song just never played".
 */

test('real locators are recognised', () => {
  for (const value of [
    'spotify:track:1OWBh1eVxUdA1Z6UA8r4nh',
    'https://example.com/a.mp3',
    'file:///Users/me/a.mp3',
    'applemusic:track:AAA111',
    'nowplaying:current',
    '/Users/me/Music/a.mp3',
    './relative.mp3',
    '../up/one.mp3',
  ]) {
    assert.equal(looksLikeLocator(value), true, value);
  }
});

test('a title with a colon is prose, not a scheme', () => {
  // The bug this covers: "Nights" is a valid scheme shape, so these were read
  // as locators and then failed to bind against any adapter.
  for (const value of [
    'Nights: The Remix',
    'Interlude: Moving On',
    'Episode 12: The One About Queues',
    'Acquired: NVIDIA',
    'Godspeed: A Tribute',
  ]) {
    assert.equal(looksLikeLocator(value), false, value);
  }
});

test('plain descriptions are prose', () => {
  for (const value of ['Bad Habit', 'something calmer after this', 'play me some jazz']) {
    assert.equal(looksLikeLocator(value), false, value);
  }
});

test('a path containing spaces is still a path', () => {
  assert.equal(looksLikeLocator('/Users/me/Music/My Favourite Song.mp3'), true);
  assert.equal(looksLikeLocator('./My Song.mp3'), true);
});

test('the runtime routes each kind to the right place', () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });

  const title = runtime.enqueue('Nights: The Remix');
  assert.equal(title.intent, 'Nights: The Remix', 'should be looked up');
  assert.equal(title.ref.uri, undefined);

  const uri = runtime.enqueue('spotify:track:abc');
  assert.equal(uri.intent, undefined, 'should be played directly');
  assert.equal(uri.ref.uri, 'spotify:track:abc');
});
