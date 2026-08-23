import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { FakeAdapter } from '../src/testing.js';
import { EVENT_CAPS } from './fixtures.js';
import { collect, flush } from './helpers.js';

test('a bare phrase becomes an unresolved intent, not a locator', () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  const item = runtime.enqueue('something calmer after this');

  assert.equal(item.status, 'pending');
  assert.equal(item.intent, 'something calmer after this');
  assert.deepEqual(item.ref, {});
});

test('a string that looks like a locator is taken literally', () => {
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  assert.equal(runtime.enqueue('spotify:track:abc').ref.uri, 'spotify:track:abc');
  assert.equal(runtime.enqueue('/Users/x/song.mp3').ref.uri, '/Users/x/song.mp3');
  assert.equal(runtime.enqueue('https://example.com/a.mp3').ref.uri, 'https://example.com/a.mp3');
});

test('the host resolves intents; the core never guesses', async () => {
  const seen: string[] = [];
  const runtime = new Runtime({
    adapters: [new FakeAdapter({ capabilities: EVENT_CAPS })],
    scheduler: new ManualScheduler(),
    lookahead: 0,
    resolveIntent: async (intent) => {
      seen.push(intent);
      return { title: 'Resolved Song', artist: 'Someone' };
    },
  });

  runtime.enqueue('something calmer');
  await runtime.play();

  assert.deepEqual(seen, ['something calmer']);
  assert.equal(runtime.nowPlaying()?.ref.title, 'Resolved Song');
});

test('the resolver sees what is playing, so "more like this" is answerable', async () => {
  let nowPlayingTitle: string | undefined;
  const runtime = new Runtime({
    adapters: [new FakeAdapter({ capabilities: EVENT_CAPS })],
    scheduler: new ManualScheduler(),
    lookahead: 0,
    resolveIntent: async (_intent, ctx) => {
      nowPlayingTitle = ctx.nowPlaying?.ref.title;
      return { title: 'Follow Up' };
    },
  });

  runtime.enqueue({ title: 'First' });
  runtime.enqueue('more like this');
  await runtime.play();
  await runtime.next();

  assert.equal(nowPlayingTitle, 'First');
});

test('lookahead resolves intents before the playhead reaches them', async () => {
  const runtime = new Runtime({
    adapters: [new FakeAdapter({ capabilities: EVENT_CAPS })],
    scheduler: new ManualScheduler(),
    lookahead: 2,
    resolveIntent: async () => ({ title: 'Prefetched' }),
  });
  const resolved = collect(runtime, 'item:resolved');

  runtime.enqueue({ title: 'First' });
  runtime.enqueue('something calmer');
  await runtime.play();
  await flush();

  assert.equal(resolved.length, 1);
  const upcoming = runtime.getQueue()[1]!;
  assert.equal(upcoming.status, 'ready', 'should be bound before it is needed');
  assert.equal(upcoming.ref.title, 'Prefetched');
});

test('without a resolver, intents fall back to adapter search', async () => {
  const adapter = new FakeAdapter({
    capabilities: { ...EVENT_CAPS, search: true },
    catalogue: [{ title: 'Nights', artist: 'Frank Ocean', uri: 'fake:nights' }],
  });
  const runtime = new Runtime({ adapters: [adapter], scheduler: new ManualScheduler() });

  runtime.enqueue('nights');
  await runtime.play();

  assert.equal(runtime.nowPlaying()?.ref.uri, 'fake:nights');
});

test('an unresolvable intent fails that entry and moves on', async () => {
  const runtime = new Runtime({
    adapters: [new FakeAdapter({ capabilities: EVENT_CAPS })],
    scheduler: new ManualScheduler(),
    resolveIntent: async () => null,
  });
  const failed = collect(runtime, 'item:failed');

  runtime.enqueue('something impossible');
  runtime.enqueue({ title: 'plays fine' });
  await runtime.play();
  await flush();

  assert.equal(failed[0]!.error.code, 'intent_unresolved');
  assert.equal(runtime.nowPlaying()?.ref.title, 'plays fine');
});
