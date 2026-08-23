import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '@upnext/core';
import type { MediaRef } from '@upnext/core';
import { LocalAdapter } from '@upnext/adapter-local';
import { writeTone } from './tones.js';

/**
 * The whole library, end to end, out loud.
 *
 * Everything here is the public API an agent harness would use. Nothing reaches
 * into internals, and nothing knows what a WAV file is except the fixture code.
 */
async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'upnext-demo-'));
  const files = await Promise.all([
    writeTone(dir, 'first', 440, 2),
    writeTone(dir, 'second', 554, 2),
    writeTone(dir, 'third', 659, 3),
  ]);

  const adapter = new LocalAdapter({ library: [dir] });
  // Annotated because the intent resolver below closes over `runtime` itself —
  // exactly what a real host does when the resolver wants queue context.
  const runtime: Runtime = new Runtime({
    adapters: [adapter],
    positionIntervalMs: 500,
    // Stands in for a model. The library never calls one itself: the host
    // decides what "something shorter" means, and hands back a MediaRef.
    resolveIntent: async (intent): Promise<MediaRef> => {
      log('resolve', `intent "${intent}"`);
      const [match] = await runtime.search(intent.replace(/[^a-z ]/gi, '').trim(), { limit: 1 });
      return match ?? { uri: files[0]! };
    },
  });

  runtime.on('item:started', ({ item }) => {
    log('playing', `${item.ref.title}  ${dim(`[${item.binding?.adapterId}]`)}`);
  });
  runtime.on('item:ended', ({ item, reason }) => log('ended', `${item.ref.title} (${reason})`));
  runtime.on('item:failed', ({ item, error }) =>
    log('failed', `${item.ref.title ?? item.intent} — ${error.message}`),
  );
  runtime.on('queue:changed', ({ version, queue }) => {
    const upcoming = queue
      .filter((i) => ['pending', 'unresolved', 'ready'].includes(i.status))
      .map((i) => i.ref.title ?? `“${i.intent}”`);
    log('queue', `v${version}  ${upcoming.join(dim(' → ')) || dim('(empty)')}`);
  });

  // Wait for the adapter to report what it can actually do on this machine.
  await settle();
  const caps = runtime.getState().adapters[0]!.capabilities;
  log('caps', Object.entries(caps).map(([k, v]) => `${k}=${v}`).join(dim('  ')));

  section('enqueue three things, including one the host has to resolve');
  runtime.enqueue({ uri: files[0]!, title: 'first' });
  runtime.enqueue('third');
  const second = runtime.enqueue({ uri: files[1]!, title: 'second' });

  section('reorder by id — never by index, so an agent cannot race a human');
  runtime.move(second.id, { next: true });

  section('play');
  await runtime.play();
  await settle(2600);

  section('skip');
  await runtime.next();
  await settle(1200);

  if (caps.pause) {
    section('pause, then resume');
    await runtime.pause();
    log('state', describe(runtime));
    await settle(800);
    await runtime.resume();
  }

  section('let it run to the end of the queue on its own');
  await waitForIdle(runtime);

  log('state', describe(runtime));
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
}

function describe(runtime: Runtime): string {
  const { status, positionMs, durationMs, capabilities } = runtime.getPlayback();
  const now = runtime.nowPlaying();
  const clock = `${(positionMs / 1000).toFixed(1)}s${durationMs ? `/${(durationMs / 1000).toFixed(1)}s` : ''}`;
  return `${status}  ${now?.ref.title ?? dim('nothing')}  ${clock} ${dim(`(${capabilities?.position ?? "unknown"})`)}`;
}

function waitForIdle(runtime: Runtime): Promise<void> {
  return new Promise((resolve) => {
    const off = runtime.on('playback:changed', (state) => {
      if (state.status === 'ended' || state.status === 'idle') {
        off();
        resolve();
      }
    });
  });
}

const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));
const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;

function log(tag: string, message: string): void {
  process.stdout.write(`${dim(tag.padStart(8))}  ${message}\n`);
}

function section(title: string): void {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
