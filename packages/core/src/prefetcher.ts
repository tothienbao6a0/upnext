import type { Binder } from './binder.js';
import { isPlayable } from './identity.js';
import type { Queue } from './queue.js';
import type { IntentContext, QueueItem } from './types/index.js';


export interface PrefetcherDeps {
  queue: Queue;
  binder: Binder;
  /** How many upcoming entries to prepare ahead of the playhead. */
  lookahead: number;
  intentContext(item: QueueItem): IntentContext;
  onResolved(item: QueueItem): void;
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
    const { queue, lookahead } = this.deps;
    if (lookahead <= 0) return;

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
        if (!ref || !this.#preparable(id)) return;
        queue.update(id, { ref, status: 'unresolved' });
        item = queue.require(id);
        this.deps.onResolved(item);
        this.deps.onChanged();
      }

      if (item.binding) return;

      const outcome = await binder.bind(item.ref, { attempted: item.attempted ?? [] });
      if (!outcome.ok || !this.#preparable(id)) return;

      queue.update(id, {
        binding: outcome.binding,
        status: 'ready',
        ref: { ...item.ref, ...outcome.binding.ref },
      });
      this.deps.onChanged();
    } finally {
      this.#inFlight.delete(id);
    }
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
