import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { desktop, explainSetup, summariseSetup } from '../src/index.js';

let library: string;

/**
 * Wait for a condition instead of guessing how long it takes.
 *
 * Lookahead touches a real filesystem, so any fixed sleep is a test that passes
 * on a quiet machine and fails on a busy one — which is worse than no test,
 * because it teaches people to rerun rather than to look.
 */
async function until<T>(check: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((r) => setTimeout(r, 10));
  }
}

before(async () => {
  library = await mkdtemp(join(tmpdir(), 'upnext-desktop-'));
  await writeFile(join(library, 'Bad Habit.mp3'), Buffer.alloc(16));
});

after(async () => {
  await rm(library, { recursive: true, force: true });
});

test('one call gets you a working runtime on any platform', async () => {
  const runtime = await desktop();
  const { available } = summariseSetup(runtime);

  // Local playback is the one backend that exists everywhere.
  assert.ok(available.some((a) => a.id === 'local'), 'expected a local adapter');
  assert.equal(runtime.getQueue().length, 0);
  await runtime.dispose();
});

test('it wires the platform-specific sources where they exist', async () => {
  const runtime = await desktop();
  const ids = summariseSetup(runtime).available.map((a) => a.id);

  if (process.platform === 'darwin') {
    assert.ok(ids.includes('nowplaying'), 'macOS should reach the Now Playing register');
  } else {
    assert.ok(!ids.includes('nowplaying'), 'a macOS-only adapter must not claim to work elsewhere');
  }
  await runtime.dispose();
});

test('you can leave one out', async () => {
  const runtime = await desktop({ exclude: ['local'] });
  assert.ok(!summariseSetup(runtime).available.some((a) => a.id === 'local'));
  await runtime.dispose();
});

test('it says out loud when nothing can resolve a bare title', async () => {
  // The silent failure this exists to prevent: links play, titles quietly do not.
  const runtime = await desktop({ exclude: ['spotify-web'] });
  const summary = summariseSetup(runtime);

  if (!summary.canResolveTitles) {
    assert.match(explainSetup(runtime), /titles will NOT resolve/);
    assert.match(explainSetup(runtime), /library|spotifyToken|resolveIntent/);
  }
  await runtime.dispose();
});

test('indexing a folder is enough to make titles resolvable', async () => {
  const runtime = await desktop({ library: [library] });
  const summary = summariseSetup(runtime);

  assert.equal(summary.canResolveTitles, true);
  assert.match(explainSetup(runtime), /titles resolve via: .*local/);
  await runtime.dispose();
});

test('and then a bare title actually plays from that folder', async () => {
  const runtime = await desktop({ library: [library] });
  const item = runtime.enqueue({ title: 'Bad Habit' });

  // Resolution is what is being checked here, not audio. Wait for the binding
  // to appear rather than sleeping a guessed interval: lookahead runs on a real
  // filesystem, and a fixed sleep is a test that fails on a busy machine.
  const prepared = await until(() => runtime.queue.get(item.id)?.binding);
  assert.equal(prepared.adapterId, 'local');
  assert.match(prepared.nativeUri, /Bad Habit\.mp3$/);

  await runtime.dispose();
});

test('explainSetup names what came up and what did not', async () => {
  const runtime = await desktop();
  const text = explainSetup(runtime);

  assert.match(text, /playing through: /);
  for (const { id, reason } of summariseSetup(runtime).unavailable) {
    assert.ok(text.includes(id) && text.includes(reason.slice(0, 20)));
  }
  await runtime.dispose();
});
