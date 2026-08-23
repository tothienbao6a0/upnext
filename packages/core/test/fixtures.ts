import { Runtime } from '../src/runtime.js';
import { ManualScheduler } from '../src/scheduler.js';
import { FakeAdapter, type FakeAdapterOptions } from '../src/testing.js';
import type { RuntimeOptions } from '../src/options.js';

/** A backend that pushes events and can be paused and seeked. */
export const EVENT_CAPS = {
  endOfTrack: 'event',
  position: 'estimated',
  pause: true,
  seek: true,
  volume: true,
} as const;

/** A backend that must be asked, and knows exactly where it is. */
export const POLL_CAPS = {
  endOfTrack: 'poll',
  position: 'authoritative',
  pause: true,
} as const;

/** A backend that can only be told to start, and timed. */
export const BLIND_CAPS = {
  endOfTrack: 'none',
  position: 'estimated',
} as const;

export interface Harness {
  runtime: Runtime;
  adapter: FakeAdapter;
  scheduler: ManualScheduler;
}

export function harness(
  adapterOptions: FakeAdapterOptions = {},
  runtimeOptions: Omit<RuntimeOptions, 'adapters' | 'scheduler'> = {},
): Harness {
  const scheduler = new ManualScheduler();
  const adapter = new FakeAdapter({ capabilities: EVENT_CAPS, ...adapterOptions });
  const runtime = new Runtime({ ...runtimeOptions, adapters: [adapter], scheduler });
  return { runtime, adapter, scheduler };
}
