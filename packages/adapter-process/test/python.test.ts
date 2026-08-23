import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { Runtime } from 'upnext';
import { ProcessAdapter } from '../src/index.js';

/**
 * The claim under test: an adapter can be written in another language and the
 * runtime cannot tell. If this suite passes, the contribution story holds.
 */

const SCRIPT = fileURLToPath(
  new URL('../../examples/python-adapter/adapter.py', import.meta.url),
);

let dir: string;
let track: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'upnext-proc-'));
  track = join(dir, 'track.wav');
  await writeFile(track, Buffer.alloc(64));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function build(): { runtime: Runtime; adapter: ProcessAdapter } {
  const adapter = new ProcessAdapter({
    id: 'python',
    command: 'python3',
    args: [SCRIPT, '--silent', '--duration-ms', '120'],
    stderr: 'ignore',
    requestTimeoutMs: 5000,
  });
  return { runtime: new Runtime({ adapters: [adapter] }), adapter };
}

test('capabilities are discovered from the child at handshake', async () => {
  const { runtime, adapter } = build();
  await adapter.init();

  assert.equal(adapter.capabilities.endOfTrack, 'event');
  assert.equal(adapter.capabilities.position, 'estimated');
  assert.equal(adapter.capabilities.nativeQueue, false, 'undeclared flags keep their defaults');
  await runtime.dispose();
});

test('match is evaluated locally from what the child declared', async () => {
  const { runtime, adapter } = build();
  await adapter.init();

  assert.equal(adapter.match({ uri: 'file:///x.wav' }), 0.9);
  assert.equal(adapter.match({ uri: 'spotify:track:x' }), 0);
  assert.equal(adapter.match({ title: 'no locator' }), 0);
  await runtime.dispose();
});

test('the runtime drives a Python backend end to end', async () => {
  const { runtime, adapter } = build();
  await adapter.init();

  const started: string[] = [];
  runtime.on('item:started', ({ item }) => started.push(item.ref.title ?? ''));

  runtime.enqueue({ uri: `file://${track}`, title: 'from python' });
  await runtime.play();

  assert.equal(runtime.getPlayback().status, 'playing');
  assert.equal(runtime.getPlayback().adapterId, 'python');
  assert.deepEqual(started, ['from python']);
  await runtime.dispose();
});

test('an event pushed over the pipe advances the queue', async () => {
  const { runtime, adapter } = build();
  await adapter.init();

  runtime.enqueue({ uri: `file://${track}`, title: 'first' });
  runtime.enqueue({ uri: `file://${track}`, title: 'second' });
  await runtime.play();

  await new Promise<void>((resolve) => {
    runtime.on('item:started', ({ item }) => {
      if (item.ref.title === 'second') resolve();
    });
  });

  assert.equal(runtime.nowPlaying()?.ref.title, 'second');
  await runtime.dispose();
});

test('a ref the child cannot resolve fails cleanly instead of hanging', async () => {
  const { runtime, adapter } = build();
  await adapter.init();

  const failures: string[] = [];
  runtime.on('item:failed', ({ error }) => failures.push(error.code));

  runtime.enqueue({ uri: 'file:///definitely/not/here.wav' });
  await runtime.play();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(failures.length, 1);
  await runtime.dispose();
});
