import type { MediaRef, QueueItem } from './types/index.js';

/**
 * What an agent is allowed to hand the queue.
 *
 * A bare string is the interesting case: if it looks like a locator it becomes
 * one, and otherwise it becomes an *intent* to be resolved later. That is what
 * makes `enqueue("something calmer after this")` and `enqueue("file:///x.mp3")`
 * both mean the obvious thing.
 */
export type EnqueueInput = string | MediaRef | { intent: string };

export function createItem(input: EnqueueInput, id: string, now: number): QueueItem {
  const base = { id, addedAt: now };

  if (typeof input === 'string') {
    return looksLikeLocator(input)
      ? { ...base, status: 'unresolved', ref: { uri: input } }
      : { ...base, status: 'pending', ref: {}, intent: input };
  }

  if (isIntent(input)) {
    return { ...base, status: 'pending', ref: {}, intent: input.intent };
  }

  return { ...base, status: 'unresolved', ref: { ...input } };
}

function isIntent(input: MediaRef | { intent: string }): input is { intent: string } {
  return 'intent' in input && typeof input.intent === 'string' && !('uri' in input);
}

/** A scheme, or a filesystem path. Anything else is prose. */
export function looksLikeLocator(value: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../')
  );
}

/** A short human-readable label, for error messages and logs. */
export function describe(ref: MediaRef): string {
  if (ref.title) return ref.artist ? `${ref.artist} — ${ref.title}` : ref.title;
  return ref.uri ?? ref.isrc ?? ref.mbid ?? 'unknown media';
}
