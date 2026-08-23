/**
 * Injectable clock and timers.
 *
 * The runtime is a time-dependent state machine, and time-dependent state
 * machines are only testable if time is a parameter. Hosts get the real thing
 * by default; tests drive `ManualScheduler` and step time by hand, so the whole
 * suite runs in microseconds with no flakes and no fake-timer library.
 */
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

interface Task {
  id: number;
  fn: () => void;
  due: number;
  every: number | null;
}

/** A deterministic scheduler for tests. */
export class ManualScheduler implements Scheduler {
  #time = 0;
  #next = 1;
  #tasks = new Map<number, Task>();

  now(): number {
    return this.#time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#tasks.set(id, { id, fn, due: this.#time + ms, every: null });
    return id;
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#tasks.set(id, { id, fn, due: this.#time + ms, every: Math.max(1, ms) });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#tasks.delete(handle as number);
  }

  clearInterval(handle: unknown): void {
    this.#tasks.delete(handle as number);
  }

  /** Advance time, firing everything due along the way in order. */
  advance(ms: number): void {
    const target = this.#time + ms;
    for (;;) {
      const due = [...this.#tasks.values()]
        .filter((task) => task.due <= target)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!due) break;
      this.#time = due.due;
      if (due.every === null) this.#tasks.delete(due.id);
      else due.due = this.#time + due.every;
      due.fn();
    }
    this.#time = target;
  }

  get pending(): number {
    return this.#tasks.size;
  }
}
