import type { Scheduler } from './scheduler.js';

/**
 * Where the playhead is.
 *
 * Backends that report position authoritatively push values in via `set`.
 * Backends that cannot get the same interface, extrapolated from a local clock
 * — which is exactly why `Capabilities.position` exists to tell an agent which
 * kind of number it is looking at.
 */
export class PositionTracker {
  #baseMs = 0;
  #anchoredAt: number;
  #running = false;

  constructor(private readonly scheduler: Scheduler) {
    this.#anchoredAt = scheduler.now();
  }

  get value(): number {
    if (!this.#running) return this.#baseMs;
    return this.#baseMs + (this.scheduler.now() - this.#anchoredAt);
  }

  /** Re-anchor to a known position, e.g. after a seek or a poll. */
  set(positionMs: number): void {
    this.#baseMs = Math.max(0, positionMs);
    this.#anchoredAt = this.scheduler.now();
  }

  start(): void {
    if (this.#running) return;
    this.#anchoredAt = this.scheduler.now();
    this.#running = true;
  }

  stop(): void {
    if (!this.#running) return;
    this.#baseMs = this.value;
    this.#running = false;
  }
}
