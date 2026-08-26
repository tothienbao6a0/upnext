import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManualScheduler, Runtime } from 'upnext-core';
import { FakeAdapter } from 'upnext-core/testing';
import { createServer } from '../src/index.js';

/**
 * Exercised through the server's own registry rather than by calling the
 * handlers directly, so the schemas are part of what is under test. A tool whose
 * declared input does not match what it reads is broken in exactly the way a
 * unit test that bypasses the schema will never notice.
 */

interface ToolLike {
  description?: string;
  inputSchema?: { parse: (value: unknown) => unknown };
  handler: (args: never) => Promise<{ content: Array<{ text: string }> }>;
}

function build() {
  const adapter = new FakeAdapter({
    capabilities: { endOfTrack: 'event', position: 'estimated', pause: true, seek: true, search: true },
    catalogue: [
      { title: 'Bad Habit', artist: 'Steve Lacy', uri: 'fake:bad-habit' },
      { title: 'Nights', artist: 'Frank Ocean', uri: 'fake:nights' },
    ],
  });
  const runtime = new Runtime({ adapters: [adapter], scheduler: new ManualScheduler() });
  const server = createServer(runtime);
  const tools = (server as unknown as { _registeredTools: Record<string, ToolLike> })._registeredTools;

  // Arguments go through the tool's *declared* schema before reaching the
  // handler, exactly as they would from a client. A tool whose schema does not
  // match what it reads is broken in precisely the way a test that calls the
  // handler directly will never notice.
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools[name];
    assert.ok(tool, `tool ${name} is not registered`);
    const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
    const result = await tool.handler(parsed as never);
    return result.content.map((c) => c.text).join('\n');
  };

  return { runtime, adapter, call, names: Object.keys(tools) };
}

test('every documented tool is actually registered', () => {
  const { names } = build();
  for (const expected of [
    'media_now', 'media_queue', 'media_enqueue', 'media_play', 'media_pause',
    'media_next', 'media_seek', 'media_move', 'media_remove', 'media_search',
    'media_adopt_current', 'media_setup',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test('enqueue then queue shows the entry with an id a model can use', async () => {
  const { call } = build();
  const queued = await call('media_enqueue', { item: 'fake:bad-habit' });
  assert.match(queued, /queued q_\d+/);

  const listing = await call('media_queue');
  assert.match(listing, /up next:/);
  assert.match(listing, /q_\d+\s+fake:bad-habit/);
});

test('position next puts it in front of what was already queued', async () => {
  const { call, runtime } = build();
  const first = /queued (q_\d+)/.exec(await call('media_enqueue', { item: 'fake:nights' }))![1]!;
  const jumped = /queued (q_\d+)/.exec(
    await call('media_enqueue', { item: 'fake:bad-habit', position: 'next' }),
  )![1]!;

  // Asserted on ids rather than on the rendered labels: a label legitimately
  // changes from the raw uri to "Nights — Frank Ocean" the moment lookahead
  // resolves it, so matching on text is a test that depends on timing.
  assert.deepEqual(runtime.getQueue().map((i) => i.id), [jumped, first]);

  const listing = await call('media_queue');
  assert.ok(listing.indexOf(jumped) < listing.indexOf(first), `wrong order:\n${listing}`);
});

test('play reports back what is now playing', async () => {
  const { call } = build();
  await call('media_enqueue', { item: 'fake:bad-habit' });
  const out = await call('media_play');
  assert.match(out, /▶/);
});

test('seek explains itself instead of throwing when the backend cannot', async () => {
  const runtime = new Runtime({
    adapters: [new FakeAdapter({ capabilities: { endOfTrack: 'event', seek: false } })],
    scheduler: new ManualScheduler(),
  });
  const server = createServer(runtime);
  const tools = (server as unknown as { _registeredTools: Record<string, ToolLike> })._registeredTools;

  runtime.enqueue('fake:x');
  await runtime.play();

  const parsed = tools.media_seek!.inputSchema!.parse({ seconds: 30 });
  const out = (await tools.media_seek!.handler(parsed as never)).content[0]!.text;
  assert.match(out, /cannot seek/);
  assert.match(out, /Nothing changed/);
});

test('search returns uris that enqueue accepts', async () => {
  const { call } = build();
  const results = await call('media_search', { query: 'nights' });
  assert.match(results, /fake:nights/);

  const uri = /fake:[a-z-]+/.exec(results)![0];
  assert.match(await call('media_enqueue', { item: uri }), /queued/);
});

test('a search with no hits explains why rather than returning nothing', async () => {
  const runtime = new Runtime({
    adapters: [new FakeAdapter({ capabilities: { endOfTrack: 'event' } })], // search: false
    scheduler: new ManualScheduler(),
  });
  const server = createServer(runtime);
  const tools = (server as unknown as { _registeredTools: Record<string, ToolLike> })._registeredTools;

  const parsed = tools.media_search!.inputSchema!.parse({ query: 'anything' });
  const out = (await tools.media_search!.handler(parsed as never)).content[0]!.text;
  assert.match(out, /nothing found/);
  assert.match(out, /titles will NOT resolve|titles resolve via/);
});

test('move and remove work on the ids the queue hands out', async () => {
  const { call, runtime } = build();
  await call('media_enqueue', { item: 'fake:nights' });
  await call('media_enqueue', { item: 'fake:bad-habit' });

  const [first, second] = runtime.getQueue();
  await call('media_move', { id: second!.id });
  assert.equal(runtime.getQueue()[0]!.id, second!.id);

  await call('media_remove', { id: first!.id });
  assert.equal(runtime.getQueue().length, 1);
});

test('setup reports what is wired', async () => {
  const { call } = build();
  assert.match(await call('media_setup'), /playing through: fake/);
});
