import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ManualScheduler, Runtime } from 'upnext-core';
import { FakeAdapter } from 'upnext-core/testing';
import { serveHttp, type HttpHandle } from '../src/index.js';

/**
 * Driven over real HTTP against a real listening socket.
 *
 * A transport tested by calling its handler directly proves nothing about the
 * transport — routing, status codes, headers and body parsing are the whole of
 * what this package is.
 */

const CAPS = { endOfTrack: 'event', position: 'estimated', pause: true, seek: true } as const;

let runtime: Runtime;
let adapter: FakeAdapter;
let server: HttpHandle;

before(async () => {
  adapter = new FakeAdapter({ capabilities: CAPS });
  runtime = new Runtime({ adapters: [adapter], scheduler: new ManualScheduler(), lookahead: 0 });
  server = await serveHttp({ runtime });
});

after(async () => {
  await server.close();
  await runtime.dispose();
});

const call = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${server.url}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
};

const post = (path: string, body?: unknown) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test('it listens and answers', async () => {
  const { status, body } = await call('/health');
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('the queue can be read, added to, and reordered by id', async () => {
  const first = await post('/queue', { item: 'fake:one' });
  assert.equal(first.status, 201);
  const firstId = (first.body.item as { id: string }).id;

  const second = await post('/queue', { item: 'fake:two' });
  const secondId = (second.body.item as { id: string }).id;

  const listed = await call('/queue');
  assert.deepEqual((listed.body.queue as Array<{ id: string }>).map((i) => i.id), [
    firstId,
    secondId,
  ]);

  const moved = await post(`/queue/${secondId}/move`);
  assert.equal(moved.status, 200);
  assert.deepEqual((moved.body.queue as Array<{ id: string }>).map((i) => i.id), [
    secondId,
    firstId,
  ]);

  const removed = await call(`/queue/${firstId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((removed.body.queue as unknown[]).length, 1);
});

test('transport works, and state comes back with it', async () => {
  await post('/queue', { item: 'fake:play-me' });
  const played = await post('/play');
  assert.equal(played.status, 200);
  assert.equal((played.body.playback as { status: string }).status, 'playing');

  const paused = await post('/pause');
  assert.equal((paused.body.playback as { status: string }).status, 'paused');

  const resumed = await post('/resume');
  assert.equal((resumed.body.playback as { status: string }).status, 'playing');
});

test('a backend that cannot seek answers with a reason, not a stack trace', async () => {
  const blind = new FakeAdapter({ id: 'blind', capabilities: { endOfTrack: 'event', seek: false } });
  const other = new Runtime({ adapters: [blind], scheduler: new ManualScheduler(), lookahead: 0 });
  const handle = await serveHttp({ runtime: other });

  await fetch(`${handle.url}/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item: 'blind:x' }),
  });
  await fetch(`${handle.url}/play`, { method: 'POST' });

  const res = await fetch(`${handle.url}/seek`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ms: 30_000 }),
  });
  assert.equal(res.status, 409, 'a refusal, not a failure');
  assert.match(((await res.json()) as { error: string }).error, /cannot seek/);

  await handle.close();
  await other.dispose();
});

test('bad input is refused with 400, not 500', async () => {
  assert.equal((await post('/queue', { item: 42 })).status, 400);
  assert.equal((await post('/seek', { ms: 'soon' })).status, 400);
  assert.equal((await post('/volume', {})).status, 400);

  const malformed = await call('/seek', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(malformed.status, 500);
  assert.match(String(malformed.body.error), /must be JSON/);
});

test('unknown routes and unknown ids are 404', async () => {
  assert.equal((await call('/nonsense')).status, 404);
  assert.equal((await call('/queue/q_9999', { method: 'DELETE' })).status, 404);
});

test('events stream live, starting with the current state', async () => {
  const controller = new AbortController();
  const res = await fetch(`${server.url}/events`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /^event: state/, 'a client joining mid-track should not have to wait');

  // Something happens; the stream should carry it.
  await post('/queue', { item: 'fake:streamed' });
  let seen = '';
  for (let i = 0; i < 5 && !seen.includes('queue:changed'); i++) {
    seen += decoder.decode((await reader.read()).value);
  }
  assert.match(seen, /event: queue:changed/);

  controller.abort();
});

test('a token is demanded when one is set, and compared in full', async () => {
  const guarded = new Runtime({ scheduler: new ManualScheduler() });
  const handle = await serveHttp({ runtime: guarded, token: 'sekrit' });

  assert.equal((await fetch(`${handle.url}/state`)).status, 401);
  assert.equal(
    (await fetch(`${handle.url}/state`, { headers: { authorization: 'Bearer wrong!' } })).status,
    401,
  );
  assert.equal(
    (await fetch(`${handle.url}/state`, { headers: { authorization: 'Bearer sekrit' } })).status,
    200,
  );
  // Health stays open, so a supervisor can check liveness without the secret.
  assert.equal((await fetch(`${handle.url}/health`)).status, 200);

  await handle.close();
  await guarded.dispose();
});

test('it refuses to leave the loopback without a token', async () => {
  const other = new Runtime({ scheduler: new ManualScheduler() });
  await assert.rejects(
    () => serveHttp({ runtime: other, host: '0.0.0.0' }),
    /refusing to listen on 0\.0\.0\.0 without a token/,
  );
  await other.dispose();
});

test('an oversized body is rejected rather than buffered', async () => {
  const res = await call('/queue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item: 'x'.repeat(100_000) }),
  });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /too large/);
});

test('closing releases the port even with a stream still open', async () => {
  const other = new Runtime({ scheduler: new ManualScheduler() });
  const handle = await serveHttp({ runtime: other });
  const controller = new AbortController();
  await fetch(`${handle.url}/events`, { signal: controller.signal });

  // An event stream holds its socket open for ever by design, so `close` has to
  // end them itself or it waits for a client that is never going to hang up.
  await handle.close();

  await assert.rejects(() => fetch(`${handle.url}/health`));
  controller.abort();
  await other.dispose();
});
