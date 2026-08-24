import type { Scheduler } from 'upnext-core';
import type { AdapterEvent } from 'upnext-core';
import type { Sample } from './applescript.js';
import { SpotifyError } from './errors.js';
import { initialWatchState, interpret, type WatchState } from './sampler.js';

export interface BackendWatcherDeps {
  /** Take one reading. `null` means the reading was unusable, not that it failed. */
  read(): Promise<Sample | null>;
  emit(event: AdapterEvent): void;
  scheduler: Scheduler;
  intervalMs: number;
  rolloverWindowMs: number;
  confirmWithin: number;
}

/**
 * The loop that turns readings into events, shared by both backends.
 *
 * Extracted because the desktop app and the Web API differ only in how a
 * reading is *taken* — one shells out to `osascript`, the other makes an HTTP
 * call — and are identical in what happens around it: do not let a slow read
 * stack up behind itself, do not report the same outage once a second, decide
 * what changed, and stop the moment a track ends so nothing ends twice.
 *
 * Keeping one copy is not only tidier, it is safer. The re-targeting below is
 * subtle enough that having it in two places would mean having it wrong in one.
 */
export class BackendWatcher {
  #deps: BackendWatcherDeps;
  #target: string | null = null;
  #state: WatchState = initialWatchState;
  #timer: unknown = null;
  #reading = false;
  #failing = false;

  constructor(deps: BackendWatcherDeps) {
    this.#deps = deps;
  }

  /** What this watcher currently believes it is following. */
  get target(): string | null {
    return this.#target;
  }

  start(nativeUri: string): void {
    this.#target = nativeUri;
    this.#state = initialWatchState;
    this.#failing = false;
    if (this.#timer !== null) return;
    this.#timer = this.#deps.scheduler.setInterval(() => {
      void this.tick();
    }, this.#deps.intervalMs);
  }

  stop(): void {
    this.#target = null;
    this.#state = initialWatchState;
    if (this.#timer === null) return;
    this.#deps.scheduler.clearInterval(this.#timer);
    this.#timer = null;
    this.#reading = false;
  }

  /** One pass. Exposed so a test can step it without a scheduler. */
  async tick(): Promise<void> {
    // A slow read must not let ticks pile up behind it. Skipping is the right
    // response rather than queueing: the next reading supersedes this one, so a
    // dropped pass costs a second of resolution and nothing else.
    if (this.#reading) return;
    const target = this.#target;
    if (target === null) return;

    this.#reading = true;
    let sample: Sample | null;
    try {
      sample = await this.#deps.read();
      this.#failing = false;
    } catch (err) {
      this.#report(err);
      return;
    } finally {
      this.#reading = false;
    }

    // The world moved while we were awaiting: something else is loaded now and
    // this reading describes the track before it.
    if (this.#target !== target || !sample) return;

    const { events, state } = interpret(target, this.#state, sample, {
      rolloverWindowMs: this.#deps.rolloverWindowMs,
      confirmWithin: this.#deps.confirmWithin,
    });
    this.#state = state;

    /**
     * Follow the backend when a person moves it.
     *
     * Without this the watcher would go on comparing every reading against the
     * track the listener already abandoned, announce a takeover again a second
     * later, and again after that — and since the runtime's default is to adopt
     * what the human chose, each one would add another entry to the queue. A
     * takeover is one piece of news; after it, this *is* the track we are on.
     *
     * Whichever way the runtime rules, this ends up correct: on `adopt` the
     * runtime never calls `load` again, so re-targeting here is the only thing
     * that keeps the two in step; on `correct` it calls `load` and `play`,
     * which resets this watcher outright; on `ignore` following along is
     * precisely what ignoring means.
     */
    const takeover = events.find((event) => event.type === 'external');
    if (takeover?.type === 'external' && takeover.nativeUri) {
      this.#target = takeover.nativeUri;
      this.#state = { last: sample, confirmed: true, attempts: 0, complained: false };
    }

    // Stop before announcing. The runtime tears this down on its way to the
    // next entry, but not before the timer could have fired again, and one
    // track must never end twice.
    if (events.some((event) => event.type === 'ended')) this.stop();
    for (const event of events) this.#deps.emit(event);
  }

  /**
   * Say an outage happened once, not once per tick.
   *
   * A machine that has just declined Automation permission, or a token that has
   * stopped working, would otherwise emit an identical error every interval for
   * as long as the queue is open. A rate limit additionally stops the loop: the
   * watcher is the only thing here that runs unasked, so it is the only thing
   * that can dig the hole deeper on its own.
   */
  #report(err: unknown): void {
    this.#reading = false;
    if (!this.#failing) {
      this.#failing = true;
      this.#deps.emit({
        type: 'error',
        code: err instanceof SpotifyError ? err.reason : 'sample_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (err instanceof SpotifyError && err.reason === 'rate-limited') this.stop();
  }
}
