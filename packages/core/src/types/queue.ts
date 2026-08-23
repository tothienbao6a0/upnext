import type { Binding, MediaRef } from './media.js';

export type ItemStatus =
  /** An intent that has not been turned into a MediaRef yet. */
  | 'pending'
  /** Has a MediaRef but no Binding. */
  | 'unresolved'
  /** Bound to an adapter, ready to play. */
  | 'ready'
  /** Currently loaded in an adapter. */
  | 'active'
  | 'ended'
  | 'skipped'
  | 'failed';

export interface SerializedError {
  code: string;
  message: string;
  adapterId?: string;
}

export interface QueueItem {
  /** Stable for the lifetime of the entry. All mutation is addressed by this. */
  id: string;
  status: ItemStatus;
  /** What the agent asked for, in natural language, if it was an intent. */
  intent?: string;
  /** What we think this is. Empty until an intent resolves. */
  ref: MediaRef;
  /** Which adapter will play it, once decided. */
  binding?: Binding;
  /** Adapters already tried and rejected for this item. */
  attempted?: string[];
  error?: SerializedError;
  addedAt: number;
}

/** Where to put an item. Always addressed by id — never by index. */
export interface Position {
  /** Insert immediately after this item. */
  after?: string;
  /** Insert immediately before this item. */
  before?: string;
  /** Insert at the head of the upcoming section (play next). */
  next?: boolean;
  /** Insert at the very end. The default. */
  end?: boolean;
}
