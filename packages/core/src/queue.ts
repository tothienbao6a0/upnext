import { UpNextError, ErrorCodes } from './errors.js';
import { identityKey } from './identity.js';
import type { ItemStatus, Position, QueueItem } from './types/index.js';

/**
 * Everything a consumer may do to the queue: look at it.
 *
 * Mutation goes through the runtime, which is the only thing that knows to
 * announce the change, re-run lookahead and tell the deck. A queue that can be
 * edited behind the runtime's back is a silent desync in the one place this
 * library exists to prevent one.
 */
export interface ReadonlyQueue {
  readonly version: number;
  readonly length: number;
  readonly cursorId: string | null;
  list(): QueueItem[];
  get(id: string): QueueItem | undefined;
  indexOf(id: string): number;
  upcoming(): QueueItem[];
  nextPlayable(fromId: string | null): QueueItem | undefined;
  previousPlayable(fromId: string | null): QueueItem | undefined;
  duplicatesOf(item: QueueItem): QueueItem[];
}

/**
 * An ordered list of queue entries addressed exclusively by stable id.
 *
 * Index-based mutation is not offered on purpose. The moment an agent and a
 * human both touch the queue, "move item 3 to position 1" is a race — by the
 * time the agent's call lands, position 3 is a different song. Every mutation
 * here names ids, and every mutation bumps `version` so a caller can detect
 * that the world moved under it.
 *
 * Every read hands out a copy. Entries are mutable objects and the runtime puts
 * them straight into event payloads, so returning live references would let any
 * subscriber corrupt queue state — and would mean a payload a host held onto
 * quietly changed underneath it later.
 */
export class Queue {
  #items: QueueItem[] = [];
  #version = 0;
  /** The item playback is currently anchored to; `Position.next` inserts after it. */
  cursorId: string | null = null;

  get version(): number {
    return this.#version;
  }

  get length(): number {
    return this.#items.length;
  }

  list(): QueueItem[] {
    return this.#items.map(clone);
  }

  get(id: string): QueueItem | undefined {
    const item = this.#live(id);
    return item ? clone(item) : undefined;
  }

  require(id: string): QueueItem {
    return clone(this.#require(id));
  }

  indexOf(id: string): number {
    return this.#items.findIndex((item) => item.id === id);
  }

  /** Everything after the cursor, in play order. */
  upcoming(): QueueItem[] {
    const start = this.cursorId ? this.indexOf(this.cursorId) + 1 : 0;
    return this.#items.slice(Math.max(0, start)).map(clone);
  }

  /**
   * The next entry eligible to play after `fromId`. Skips entries that already
   * ended, were skipped, or failed outright.
   */
  nextPlayable(fromId: string | null): QueueItem | undefined {
    const start = fromId ? this.indexOf(fromId) + 1 : 0;
    for (let i = Math.max(0, start); i < this.#items.length; i++) {
      const item = this.#items[i]!;
      if (isPlayableStatus(item.status)) return clone(item);
    }
    return undefined;
  }

  previousPlayable(fromId: string | null): QueueItem | undefined {
    const start = fromId ? this.indexOf(fromId) : this.#items.length;
    for (let i = start - 1; i >= 0; i--) {
      const item = this.#items[i]!;
      if (item.status !== 'failed') return clone(item);
    }
    return undefined;
  }

  insert(item: QueueItem, position: Position = {}): QueueItem {
    const index = this.#resolvePosition(position);
    this.#items.splice(index, 0, item);
    this.#version++;
    return clone(item);
  }

  move(id: string, position: Position): void {
    const from = this.indexOf(id);
    if (from < 0) throw new UpNextError(ErrorCodes.NotFound, `no queue item with id ${id}`);
    const [item] = this.#items.splice(from, 1);
    // Resolve the target *after* removal so anchors reflect the list the item
    // is landing in, not the one it left.
    const to = this.#resolvePosition(position);
    this.#items.splice(to, 0, item!);
    this.#version++;
  }

  remove(id: string): QueueItem | undefined {
    const index = this.indexOf(id);
    if (index < 0) return undefined;
    const [item] = this.#items.splice(index, 1);
    if (this.cursorId === id) this.cursorId = null;
    this.#version++;
    return item ? clone(item) : undefined;
  }

  /** Patch an entry in place. The only sanctioned way to change item state. */
  update(id: string, patch: Partial<Omit<QueueItem, 'id'>>): QueueItem {
    const item = this.#require(id);
    Object.assign(item, patch);
    this.#version++;
    return clone(item);
  }

  /**
   * Drop entries. By default clears everything except the active item, which is
   * almost always what "clear the queue" means to a person listening to music.
   */
  clear(opts: { keepActive?: boolean } = {}): void {
    const keepActive = opts.keepActive ?? true;
    this.#items = keepActive ? this.#items.filter((item) => item.id === this.cursorId) : [];
    if (!keepActive) this.cursorId = null;
    this.#version++;
  }

  /** Entries sharing an identity with `item`, ignoring the item itself. */
  duplicatesOf(item: QueueItem): QueueItem[] {
    const key = identityKey(item.ref);
    if (key === 'unknown') return [];
    return this.#items
      .filter((other) => other.id !== item.id && identityKey(other.ref) === key)
      .map(clone);
  }

  /** The live entry. Private because writing to it skips versioning. */
  #live(id: string): QueueItem | undefined {
    return this.#items.find((item) => item.id === id);
  }

  #require(id: string): QueueItem {
    const item = this.#live(id);
    if (!item) throw new UpNextError(ErrorCodes.NotFound, `no queue item with id ${id}`);
    return item;
  }

  #resolvePosition(position: Position): number {
    if (position.after) {
      const index = this.indexOf(position.after);
      if (index < 0) {
        throw new UpNextError(ErrorCodes.NotFound, `anchor item ${position.after} not found`);
      }
      return index + 1;
    }
    if (position.before) {
      const index = this.indexOf(position.before);
      if (index < 0) {
        throw new UpNextError(ErrorCodes.NotFound, `anchor item ${position.before} not found`);
      }
      return index;
    }
    if (position.next) {
      if (!this.cursorId) return 0;
      const index = this.indexOf(this.cursorId);
      return index < 0 ? 0 : index + 1;
    }
    return this.#items.length;
  }
}

/**
 * A real object carrying only the read methods, not a cast.
 *
 * A type-level `Readonly<Queue>` is erased at runtime, so any consumer willing
 * to write `as any` could still corrupt the queue. This cannot be un-narrowed,
 * so the guarantee survives JavaScript.
 */
export function createQueueView(queue: Queue): ReadonlyQueue {
  return Object.freeze({
    get version() {
      return queue.version;
    },
    get length() {
      return queue.length;
    },
    get cursorId() {
      return queue.cursorId;
    },
    list: () => queue.list(),
    get: (id: string) => queue.get(id),
    indexOf: (id: string) => queue.indexOf(id),
    upcoming: () => queue.upcoming(),
    nextPlayable: (fromId: string | null) => queue.nextPlayable(fromId),
    previousPlayable: (fromId: string | null) => queue.previousPlayable(fromId),
    duplicatesOf: (item: QueueItem) => queue.duplicatesOf(item),
  });
}

function isPlayableStatus(status: ItemStatus): boolean {
  return status === 'pending' || status === 'unresolved' || status === 'ready';
}

function clone(item: QueueItem): QueueItem {
  return {
    ...item,
    ref: { ...item.ref },
    ...(item.binding ? { binding: { ...item.binding, ref: { ...item.binding.ref } } } : {}),
    ...(item.attempted ? { attempted: [...item.attempted] } : {}),
  };
}
