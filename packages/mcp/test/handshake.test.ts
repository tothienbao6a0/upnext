import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { ManualScheduler, Runtime } from 'upnext-core';
import { createServer } from '../src/index.js';

/**
 * What a client actually sees on connecting.
 *
 * Written after the published server spent three releases introducing itself
 * as version 0.1.0 while the package was 0.3.0 -- a hardcoded string, in the
 * one field every MCP client displays beside the server's name. Nothing caught
 * it, because every existing test called `createServer` and then asked the
 * object questions rather than completing a handshake with it.
 *
 * So this speaks the protocol. Two levels up for package.json, because this
 * runs compiled from dist/test/.
 */

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

/** Drive one request over a linked transport pair and hand back the reply. */
async function request(method: string, params: unknown): Promise<Record<string, any>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const runtime = new Runtime({ scheduler: new ManualScheduler() });
  const server = createServer(runtime);
  await server.connect(serverTransport);

  const reply = new Promise<Record<string, any>>((resolve, reject) => {
    clientTransport.onmessage = (message: any) => {
      if (message.id === 1) resolve(message);
    };
    setTimeout(() => reject(new Error(`no reply to ${method}`)), 5000).unref();
  });

  await clientTransport.start();
  await clientTransport.send({ jsonrpc: '2.0', id: 1, method, params } as never);

  try {
    return await reply;
  } finally {
    await clientTransport.close();
    await runtime.dispose();
  }
}

test('it introduces itself with the version it actually is', async () => {
  const message = await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'handshake-test', version: '1.0.0' },
  });

  assert.ok(message.result, `initialize failed: ${JSON.stringify(message.error)}`);
  const info = message.result.serverInfo as { name: string; version: string };

  assert.equal(info.name, 'upnext');
  assert.equal(
    info.version,
    pkg.version,
    'the version a client displays must be this package’s, not one written down years ago',
  );
});

test('a fresh client is offered every tool, each with a description', async () => {
  const message = await request('tools/list', {});
  assert.ok(message.result, `tools/list failed: ${JSON.stringify(message.error)}`);

  const tools = message.result.tools as Array<{ name: string; description?: string }>;
  assert.ok(tools.length > 0, 'a server with no tools is not worth connecting to');

  // Every tool is named to an agent by its description alone, so an empty one
  // is a tool that will not get called.
  for (const tool of tools) {
    assert.ok(tool.description?.trim(), `${tool.name} has no description`);
    assert.match(tool.name, /^media_/, 'tools share one prefix so they group in a client');
  }
});
