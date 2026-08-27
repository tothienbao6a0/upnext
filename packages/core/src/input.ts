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

/**
 * A scheme, or a filesystem path. Anything else is prose.
 *
 * The whitespace rule is what keeps titles out of here. A scheme is just
 * letters followed by a colon, which describes `spotify:` — and also describes
 * `Nights: The Remix`, `Interlude: Moving On`, and every podcast episode named
 * `Something: Something Else`. Those were being read as locators with a scheme
 * of `nights`, then failing to bind because no adapter handles that.
 *
 * A URI cannot contain a raw space; spaces are percent-encoded. So a
 * scheme-shaped string with whitespace in it is prose, whatever it looks like.
 * Paths are exempt, because `/Users/me/My Song.mp3` is perfectly ordinary.
 */
export function looksLikeLocator(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return true;
  }

  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/\s/.test(trimmed);
}

/** A short human-readable label, for error messages and logs. */
export function describe(ref: MediaRef): string {
  if (ref.title) return ref.artist ? `${ref.artist} — ${ref.title}` : ref.title;
  return ref.uri ?? ref.isrc ?? ref.mbid ?? 'unknown media';
}
