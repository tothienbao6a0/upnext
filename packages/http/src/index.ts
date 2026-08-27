import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Runtime } from 'upnext-core';

export interface HttpOptions {
  runtime: Runtime;
  /** Defaults to 0, meaning the operating system picks a free one. */
  port?: number;
  /**
   * Defaults to `127.0.0.1`.
   *
   * Loopback on purpose. This endpoint can read what somebody is listening to
   * and take control of their speakers, which is not something to put on a
   * network by accident — so reaching further than this machine has to be an
   * explicit act, and one that requires a token.
   */
  host?: string;
  /**
   * A bearer token clients must present.
   *
   * Required when `host` is anything but loopback, and refused at startup
   * otherwise. An open port controlling somebody's audio is a prank at best.
   */
  token?: string;
}

export interface HttpHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * The queue over HTTP, with a live event stream.
 *
 * The third transport, alongside the CLI and MCP, and the same shape as both: a
 * thin package on top of the runtime, so nobody importing the core inherits an
 * opinion about how it should be reached.
 *
 * Zero dependencies. `node:http` is enough for a JSON endpoint and an SSE
 * stream, and a web framework here would weigh more than everything it served.
 */
export async function serveHttp(options: HttpOptions): Promise<HttpHandle> {
  const { runtime, port = 0, host = '127.0.0.1', token } = options;

  if (!LOOPBACK.has(host) && !token) {
    throw new Error(
      `refusing to listen on ${host} without a token: anyone who can reach that ` +
        'address could read what you are listening to and take over your speakers',
    );
  }

  const streams = new Set<ServerResponse>();
  const offs = subscribe(runtime, (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of [...streams]) stream.write(frame);
  });

  const server = createServer((req, res) => {
    void handle(req, res, runtime, token, streams).catch((err: unknown) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://${host === '::1' ? '[::1]' : host}:${actual}`,
    port: actual,
    async close() {
      offs();
      for (const stream of [...streams]) stream.end();
      streams.clear();
      // Sockets held open by an event stream would keep `close` waiting for
      // ever, so they are ended above before we ask.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Every runtime event, forwarded verbatim. */
function subscribe(runtime: Runtime, emit: (event: string, data: unknown) => void): () => void {
  const names = [
    'queue:changed', 'playback:changed', 'position', 'item:started', 'item:ended',
    'item:resolved', 'item:unresolvable', 'item:failed', 'desync', 'adapter:error', 'error',
  ] as const;
  const offs = names.map((name) => runtime.on(name, (data) => emit(name, data)));
  return () => {
    for (const off of offs) off();
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: Runtime,
  token: string | undefined,
  streams: Set<ServerResponse>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  if (path === '/health') return send(res, 200, { ok: true });

  if (token) {
    const presented = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    // Compared at full length rather than short-circuiting on the first wrong
    // character, so the failure tells an attacker nothing about the token.
    if (!constantTimeEqual(presented, token)) return send(res, 401, { error: 'unauthorized' });
  }

  if (path === '/events' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // The current state up front, so a client that connects mid-track does not
    // have to wait for something to change before it knows anything.
    res.write(`event: state\ndata: ${JSON.stringify(runtime.getState())}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }

  if (path === '/state' && method === 'GET') return send(res, 200, runtime.getState());
  if (path === '/queue' && method === 'GET') return send(res, 200, { queue: runtime.getQueue() });

  if (path === '/queue' && method === 'POST') {
    const body = await readJson(req);
    const item = body.item;
    if (typeof item !== 'string' && (typeof item !== 'object' || item === null)) {
      return send(res, 400, { error: 'item must be a string or a MediaRef' });
    }
    const entry = runtime.enqueue(
      item as string,
      body.position === 'next' ? { next: true } : {},
    );
    return send(res, 201, { item: entry });
  }

  const entryMatch = /^\/queue\/([^/]+)(\/move)?$/.exec(path);
  if (entryMatch) {
    const id = decodeURIComponent(entryMatch[1]!);
    if (!runtime.queue.get(id)) return send(res, 404, { error: `no queue item ${id}` });

    if (!entryMatch[2] && method === 'DELETE') {
      runtime.remove(id);
      return send(res, 200, { queue: runtime.getQueue() });
    }
    if (entryMatch[2] && method === 'POST') {
      const body = await readJson(req);
      const after = typeof body.after === 'string' ? body.after : undefined;
      runtime.move(id, after ? { after } : { next: true });
      return send(res, 200, { queue: runtime.getQueue() });
    }
  }

  if (method === 'POST') {
    switch (path) {
      case '/play': {
        const body = await readJson(req);
        await runtime.play(typeof body.id === 'string' ? body.id : undefined);
        return send(res, 200, runtime.getState());
      }
      case '/pause':
        await runtime.pause();
        return send(res, 200, runtime.getState());
      case '/resume':
        await runtime.resume();
        return send(res, 200, runtime.getState());
      case '/next':
        await runtime.next();
        return send(res, 200, runtime.getState());
      case '/previous':
        await runtime.previous();
        return send(res, 200, runtime.getState());
      case '/seek': {
        const body = await readJson(req);
        if (typeof body.ms !== 'number' || !Number.isFinite(body.ms)) {
          return send(res, 400, { error: 'ms must be a finite number' });
        }
        // Asked before attempting, so a backend that cannot seek answers with a
        // sentence a client can show rather than a stack trace.
        if (!runtime.can('seek')) {
          return send(res, 409, {
            error: `the current source cannot seek`,
            adapterId: runtime.getPlayback().adapterId,
          });
        }
        await runtime.seek(body.ms);
        return send(res, 200, runtime.getState());
      }
      case '/volume': {
        const body = await readJson(req);
        if (typeof body.level !== 'number' || !Number.isFinite(body.level)) {
          return send(res, 400, { error: 'level must be a finite number' });
        }
        if (!runtime.can('volume')) {
          return send(res, 409, { error: 'the current source cannot set volume' });
        }
        await runtime.setVolume(body.level);
        return send(res, 200, runtime.getState());
      }
      case '/stop':
        await runtime.stop();
        return send(res, 200, runtime.getState());
    }
  }

  send(res, 404, { error: `no route for ${method} ${path}` });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A queue command is a few hundred bytes. Anything larger is a mistake or
    // an attempt to exhaust memory, and neither deserves to be buffered.
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('body must be JSON');
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
