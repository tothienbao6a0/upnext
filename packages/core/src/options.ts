import { systemScheduler, type Scheduler } from './scheduler.js';
import type { Adapter, DesyncPolicy, IntentResolver } from './types/index.js';

export interface RuntimeOptions {
  adapters?: Adapter[];
  /**
   * Turns natural language into a MediaRef. Optional: without it, bare strings
   * fall back to searching whatever adapters advertise `search`.
   */
  resolveIntent?: IntentResolver;
  /** How many upcoming entries to resolve ahead of the playhead. */
  lookahead?: number;
  /** What to do when a human moves an external player out from under us. */
  desyncPolicy?: DesyncPolicy;
  /** Minimum confidence that a resolution is the requested recording, 0..1. */
  matchThreshold?: number;
  /** Start the next entry when one finishes. Default true. */
  autoAdvance?: boolean;
  /** How often to poll adapters whose capabilities say `poll`. */
  pollIntervalMs?: number;
  /** How often to emit position updates for extrapolated backends. */
  positionIntervalMs?: number;
  /**
   * How long any single call out of the library — an adapter method, or the
   * host's intent resolver — may take before it counts as failed. `null` waits
   * forever, which risks the queue stopping with no error and nothing playing.
   */
  timeoutMs?: number | null;
  scheduler?: Scheduler;
}

export interface ResolvedOptions {
  lookahead: number;
  desyncPolicy: DesyncPolicy;
  matchThreshold: number;
  autoAdvance: boolean;
  pollIntervalMs: number;
  positionIntervalMs: number;
  timeoutMs: number | null;
  scheduler: Scheduler;
  resolveIntent: IntentResolver | undefined;
}

export function resolveOptions(options: RuntimeOptions): ResolvedOptions {
  return {
    lookahead: options.lookahead ?? 2,
    desyncPolicy: options.desyncPolicy ?? 'adopt',
    matchThreshold: options.matchThreshold ?? 0.55,
    autoAdvance: options.autoAdvance ?? true,
    pollIntervalMs: options.pollIntervalMs ?? 1000,
    positionIntervalMs: options.positionIntervalMs ?? 1000,
    timeoutMs: options.timeoutMs === undefined ? 30_000 : options.timeoutMs,
    scheduler: options.scheduler ?? systemScheduler,
    resolveIntent: options.resolveIntent,
  };
}
