import type { Binder } from './binder.js';
import { ErrorCodes, toSerializedError } from './errors.js';
import { isPlayable } from './identity.js';
import type { Queue } from './queue.js';
import type { IntentContext, QueueItem, SerializedError } from './types/index.js';

/** A bind abandoned mid-flight, which says nothing about the entry itself. */
const CANCELLED: SerializedError = {
  code: 'cancelled',
  message: 'preparation was superseded',
};


export interface PrefetcherDeps {
  queue: Queue;
  binder: Binder;
  /** How many upcoming entries to prepare ahead of the playhead. */
  lookahead: number;
  intentContext(item: QueueItem): IntentContext;
  onResolved(item: QueueItem): void;
  /** Preparation failed. Advisory — the entry is still retried at play time. */
  onUnresolvable(item: QueueItem, error: SerializedError): void;
  onChanged(): void;
}

/**
 * Prepares upcoming entries before the playhead reaches them.
 *
 * This is what makes an intent like "something calmer" viable as a queue entry:
 * by the time it comes up it has already become a real track on a real backend,
 * so there is no silence while a model thinks. Best-effort throughout — the
 * authoritative attempt happens at play time, where failures are reported.
 */
export class Prefetcher {
  #inFlight = new Set<string>();

  constructor(private readonly deps: PrefetcherDeps) {}

  /** Look ahead from the cursor and prepare anything not ready yet. */
  pump(): void {
    const { queue, binder, lookahead } = this.deps;
    if (lookahead <= 0) return;
    // With no backends registered there is nothing to prepare against, and
    // flagging every entry as unresolvable would only be reporting that the
    // host has not finished wiring up yet. Adding an adapter pumps again.
    if (binder.adapterCount === 0) return;

    let cursor = queue.cursorId;
    for (let i = 0; i < lookahead; i++) {
      const item = queue.nextPlayable(cursor);
      if (!item) return;
      cursor = item.id;
      if (item.status === 'ready' || this.#inFlight.has(item.id)) continue;
      void this.#prepare(item.id);
    }
  }

  cancel(id: string): void {
    this.#inFlight.delete(id);
  }

  async #prepare(id: string): Promise<void> {
    const { queue, binder } = this.deps;
    this.#inFlight.add(id);
    try {
      let item = this.#preparable(id);
      if (!item) return;

      if (item.intent && !isPlayable(item.ref)) {
        const ref = await binder.intent(item.intent, this.deps.intentContext(item));
        if (!this.#preparable(id)) return;
        if (!ref) {
          return this.#warn(id, {
            code: ErrorCodes.IntentUnresolved,
            message: `nothing resolved for intent: ${item.intent}`,
          });
        }
        queue.update(id, { ref, status: 'unresolved' });
        item = queue.require(id);
        this.deps.onResolved(item);
        this.deps.onChanged();
      }

      if (item.binding) return;

      const outcome = await binder.bind(item.ref, { attempted: item.attempted ?? [] });
      if (!this.#preparable(id)) return;
      if (!outcome.ok) {
        return this.#warn(id, 'cancelled' in outcome ? CANCELLED : outcome.error);
      }

      queue.update(id, {
        binding: outcome.binding,
        status: 'ready',
        ref: { ...item.ref, ...outcome.binding.ref },
      });
      this.deps.onChanged();
    } catch (err) {
      // Nothing awaits preparation, so an escaping rejection would be unhandled
      // and could take the host process down. A host resolver that throws is
      // just another reason this entry is doubtful.
      this.#warn(id, toSerializedError(err));
    } finally {
      this.#inFlight.delete(id);
    }
  }

  /**
   * Record an advisory failure without condemning the entry.
   *
   * The status is left alone deliberately: a backend that was unreachable
   * during lookahead is often fine thirty seconds later, and `#start` clears
   * the error and retries every adapter from scratch. What this buys is that a
   * host can mark the entry as doubtful now rather than discovering it when the
   * playhead arrives and nothing comes out of the speakers.
   */
  #warn(id: string, error: SerializedError): void {
    if (!this.deps.queue.get(id)) return;
    this.deps.queue.update(id, { error });
    this.deps.onUnresolvable(this.deps.queue.require(id), error);
    this.deps.onChanged();
  }

  /**
   * The entry, if it is still something worth preparing.
   *
   * Re-checked before every write, because preparation is asynchronous and the
   * playhead does not wait: by the time a resolve returns, this entry may have
   * been removed, or may already be the one playing. Writing `ready` over an
   * `active` entry would take the current track out of the runtime's own view
   * of what is playing.
   */
  #preparable(id: string): QueueItem | undefined {
    const item = this.deps.queue.get(id);
    if (!item) return undefined;
    const preparable = item.status === 'pending' || item.status === 'unresolved';
    return preparable ? item : undefined;
  }
}
