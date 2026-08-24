import type { RepeatMode } from './selection.js';
import type { QueueItem } from './types/index.js';

/** Bumped only when an older payload can no longer be read. */
export const PERSISTENCE_VERSION = 1;

export interface PersistedState {
  version: number;
  queue: QueueItem[];
  cursorId: string | null;
  repeat: RepeatMode;
  shuffle: boolean;
  /** Where the listener had got to in the entry that was playing. */
  positionMs: number;
  volume: number | null;
}

/**
 * Saving and reloading a queue across a restart.
 *
 * A desktop agent that restarts and silently loses what was lined up is worse
 * than one that never had a queue. `QueueItem` is already plain data, so a host
 * *could* stringify it themselves — but the interesting part isn't the writing,
 * it's what has to be thrown away on the way back in, and every host would get
 * that subtly wrong on their own.
 */

/**
 * What a restored entry has to forget.
 *
 * A `Binding` is a live handle to a backend session — a device that was awake,
 * a process that was running, a token that was fresh. None of that survives a
 * restart, and a stale one would send the runtime to a backend that no longer
 * has the item loaded. So bindings go, and with them the record of which
 * adapters were already tried.
 *
 * What survives is the `MediaRef`: the description of what the listener wanted.
 * Binding again from that is exactly what source-late resolution is for, and it
 * means a queue saved on a machine with Spotify can reopen on one without it
 * and still play from somewhere else.
 *
 * An intent that never resolved stays an intent. One that did keeps its ref, so
 * reopening the app does not quietly re-run a model and get a different song.
 */
function rehydrate(item: QueueItem): QueueItem {
  const { binding, attempted, error, ...rest } = item;
  void binding;
  void attempted;
  void error;

  // Terminal entries are history and are left exactly as they were.
  if (item.status === 'ended' || item.status === 'skipped' || item.status === 'failed') {
    return { ...rest };
  }

  const playable = Boolean(item.ref?.uri ?? item.ref?.isrc ?? item.ref?.mbid ?? item.ref?.title);
  return { ...rest, status: playable ? 'unresolved' : 'pending' };
}

export function serializeState(input: Omit<PersistedState, 'version'>): PersistedState {
  return { version: PERSISTENCE_VERSION, ...input };
}

export interface RestorePlan {
  items: QueueItem[];
  cursorId: string | null;
  repeat: RepeatMode;
  shuffle: boolean;
  positionMs: number;
  volume: number | null;
  /** Ids the factory must not hand out again. */
  highestId: number;
}

/**
 * Read a persisted payload, defensively.
 *
 * This has been on disk, which means it has been edited by hand, truncated by a
 * crash, or written by a version that no longer exists. Entries that make no
 * sense are dropped rather than allowed to fail the whole restore — losing one
 * song beats losing the queue.
 */
export function planRestore(input: unknown): RestorePlan {
  const state = (input ?? {}) as Partial<PersistedState>;

  if (state.version !== PERSISTENCE_VERSION) {
    throw new Error(
      `cannot read persisted queue: expected version ${PERSISTENCE_VERSION}, got ${String(state.version)}`,
    );
  }

  const items: QueueItem[] = [];
  let highestId = 0;

  for (const raw of Array.isArray(state.queue) ? state.queue : []) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as QueueItem;
    if (typeof item.id !== 'string' || !item.id) continue;
    if (!item.ref || typeof item.ref !== 'object') continue;

    items.push(rehydrate({ ...item, addedAt: typeof item.addedAt === 'number' ? item.addedAt : 0 }));
    highestId = Math.max(highestId, idNumber(item.id));
  }

  const ids = new Set(items.map((item) => item.id));
  const cursorId = typeof state.cursorId === 'string' && ids.has(state.cursorId)
    ? state.cursorId
    : null;

  return {
    items,
    cursorId,
    repeat: isRepeat(state.repeat) ? state.repeat : 'off',
    shuffle: state.shuffle === true,
    positionMs: typeof state.positionMs === 'number' && state.positionMs >= 0 ? state.positionMs : 0,
    volume: typeof state.volume === 'number' ? state.volume : null,
    highestId,
  };
}

/**
 * The counter behind an id like `q_0007`.
 *
 * Restoring without this is a genuine corruption: the id factory would start at
 * one again and hand out `q_0001` to a new entry while a restored `q_0001` is
 * still in the queue, and every id-addressed call would then hit whichever one
 * `find` reached first.
 */
function idNumber(id: string): number {
  const digits = /_(\d+)$/.exec(id)?.[1];
  const value = digits ? Number.parseInt(digits, 10) : 0;
  return Number.isFinite(value) ? value : 0;
}

function isRepeat(value: unknown): value is RepeatMode {
  return value === 'off' || value === 'one' || value === 'all';
}
