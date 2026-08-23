import type { Runtime } from '../src/runtime.js';
import type { RuntimeEvents } from '../src/types/index.js';

/** A promise a test can release by hand, for pausing the runtime mid-await. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let pending microtasks and promise chains settle. */
export function flush(times = 4): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i++) chain = chain.then(() => new Promise((r) => setImmediate(r)));
  return chain;
}

export function collect<K extends keyof RuntimeEvents>(
  runtime: Runtime,
  event: K,
): RuntimeEvents[K][] {
  const out: RuntimeEvents[K][] = [];
  runtime.on(event, (payload) => out.push(payload));
  return out;
}
