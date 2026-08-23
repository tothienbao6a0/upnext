import type { MediaRef } from './media.js';
import type { PlaybackState } from './playback.js';
import type { QueueItem, SerializedError } from './queue.js';

export interface IntentContext {
  /** The item being resolved. */
  item: QueueItem;
  /** What is playing right now, for "something like this but calmer". */
  nowPlaying: QueueItem | null;
  /** The rest of the queue, for context. */
  queue: readonly QueueItem[];
}

/**
 * Turns natural language into a MediaRef.
 *
 * This is the boundary that keeps the library embeddable: the core never calls
 * a model, never holds an API key, never picks a provider. The host supplies
 * this, so the same runtime works inside an LLM agent, a voice assistant, or a
 * plain app that maps strings to files with a regex.
 */
export type IntentResolver = (
  intent: string,
  ctx: IntentContext,
) => Promise<MediaRef | MediaRef[] | null>;

/** What the runtime does when a human changes the backend out from under it. */
export type DesyncPolicy =
  /** Accept the human's choice and fold it into the queue. The default. */
  | 'adopt'
  /** Force the backend back to what the runtime wanted. */
  | 'correct'
  /** Report it and do nothing. */
  | 'ignore';

export interface RuntimeEvents {
  'queue:changed': { version: number; queue: QueueItem[] };
  'playback:changed': PlaybackState;
  'position': { itemId: string; positionMs: number; durationMs: number | null };
  'item:resolved': { item: QueueItem };
  'item:started': { item: QueueItem };
  'item:ended': { item: QueueItem; reason: 'completed' | 'skipped' | 'replaced' };
  'item:failed': { item: QueueItem; error: SerializedError };
  /** The active backend diverged from the runtime's belief about the world. */
  'desync': {
    expected: string | null;
    actual: string | null;
    action: 'adopted' | 'corrected' | 'ignored';
  };
  'adapter:error': { adapterId: string; error: SerializedError };
}
