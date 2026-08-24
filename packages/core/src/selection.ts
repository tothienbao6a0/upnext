import type { ReadonlyQueue } from './queue.js';
import type { QueueItem } from './types/index.js';

export type RepeatMode = 'off' | 'one' | 'all';

export interface SelectionState {
  repeat: RepeatMode;
  shuffle: boolean;
}

/**
 * What to do when the current entry finishes.
 *
 * A plan rather than an action, so the decision is pure and testable and the
 * runtime stays the only thing that mutates the queue.
 */
export type NextPlan =
  /** Start this entry. */
  | { kind: 'play'; id: string }
  /** Start this entry again from the top — repeat one. */
  | { kind: 'replay'; id: string }
  /** Everything has played; revive the consumed entries and start this one. */
  | { kind: 'restart'; id: string }
  /** Nothing left to do. */
  | { kind: 'stop' };

/** Entries eligible to play: not yet consumed, and not known-broken. */
const PLAYABLE = new Set<QueueItem['status']>(['pending', 'unresolved', 'ready']);

/** Entries that played and could play again if the queue wraps. */
const CONSUMED = new Set<QueueItem['status']>(['ended', 'skipped']);

/**
 * Choose what plays next.
 *
 * Repeat and shuffle live here rather than on an adapter because they are
 * properties of *the queue*, not of any backend. Spotify has its own repeat
 * button, but so does Apple Music, and neither knows about the browser tab
 * queued behind it — the only place the question can be answered once is above
 * all of them.
 *
 * `random` is injected so shuffle is exactly reproducible in a test. A shuffle
 * you cannot pin down is a shuffle you cannot debug when a listener says it
 * played the same song twice.
 */
export function selectNext(
  queue: ReadonlyQueue,
  fromId: string | null,
  state: SelectionState,
  random: () => number,
): NextPlan {
  // Repeat-one outranks everything: the listener asked for this track, again,
  // and shuffling within a single track is meaningless.
  if (state.repeat === 'one' && fromId && queue.get(fromId)) {
    return { kind: 'replay', id: fromId };
  }

  const items = queue.list();
  const playable = items.filter((item) => PLAYABLE.has(item.status));

  if (playable.length > 0) {
    const chosen = state.shuffle
      ? pick(playable, random)
      : (queue.nextPlayable(fromId) ?? playable[0]!);
    return { kind: 'play', id: chosen.id };
  }

  if (state.repeat === 'all') {
    const revivable = items.filter((item) => CONSUMED.has(item.status));
    if (revivable.length > 0) {
      const chosen = state.shuffle ? pick(revivable, random) : revivable[0]!;
      return { kind: 'restart', id: chosen.id };
    }
  }

  return { kind: 'stop' };
}

function pick<T>(items: readonly T[], random: () => number): T {
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
  return items[index]!;
}
