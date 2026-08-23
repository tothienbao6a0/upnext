import type { MediaRef } from './types/index.js';

/**
 * Cross-source identity.
 *
 * Two entries refer to the same recording if a strong external id matches, or
 * failing that if normalized title + artist match closely enough. Strong ids
 * are checked first and are conclusive; the fuzzy path is only a fallback,
 * because "same title and artist" is genuinely ambiguous (live versions,
 * remasters, remixes) and should never override an ISRC.
 */

const NOISE =
  /\s*[([]\s*(remaster(ed)?|deluxe|expanded|mono|stereo|bonus track|radio edit|explicit|clean|feat\.?[^)\]]*|ft\.?[^)\]]*|with[^)\]]*)\s*(\d{2,4})?\s*[)\]]/gi;

export function normalizeText(value: string | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(NOISE, ' ')
    .replace(/[‘’“”]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Only the primary artist — "A feat. B" and "A & B" both reduce to "a".
 *
 * Note that commas are *not* separators here. Catalogues disagree about them,
 * and "Tyler, The Creator" is one artist, so splitting on a comma breaks more
 * names than it fixes.
 */
export function primaryArtist(value: string | undefined): string {
  if (!value) return '';
  const [head = ''] = normalizeText(value).split(/ and | with | feat | featuring | ft | vs /);
  return head.trim();
}

/**
 * A stable key for de-duplication and cross-source matching. Prefers strong
 * ids; falls back to normalized metadata; falls back to the raw uri.
 */
export function identityKey(ref: MediaRef): string {
  if (ref.isrc) return `isrc:${ref.isrc.toUpperCase()}`;
  if (ref.mbid) return `mbid:${ref.mbid.toLowerCase()}`;
  const title = normalizeText(ref.title);
  const artist = primaryArtist(ref.artist);
  if (title && artist) return `meta:${artist}|${title}`;
  if (ref.uri) return `uri:${ref.uri}`;
  if (title) return `meta:|${title}`;
  return 'unknown';
}

/**
 * Confidence that two refs are the same recording, 0..1.
 *
 * Used when an adapter resolves a ref and the runtime needs to decide whether
 * what came back is actually what was asked for — the failure mode that makes
 * naive cross-source matching play the wrong song.
 */
export function similarity(a: MediaRef, b: MediaRef): number {
  if (a.isrc && b.isrc) return a.isrc.toUpperCase() === b.isrc.toUpperCase() ? 1 : 0;
  if (a.mbid && b.mbid) return a.mbid.toLowerCase() === b.mbid.toLowerCase() ? 1 : 0;
  if (a.uri && b.uri && a.uri === b.uri) return 1;

  const titleA = normalizeText(a.title);
  const titleB = normalizeText(b.title);
  if (!titleA || !titleB) return 0;

  let score = 0.7 * tokenOverlap(titleA, titleB);

  const artistA = primaryArtist(a.artist);
  const artistB = primaryArtist(b.artist);
  if (artistA && artistB) score += 0.3 * tokenOverlap(artistA, artistB);
  else score += 0.15; // Unknown artist on one side: neither confirm nor punish.

  // Durations that disagree by more than 5s are usually a different cut.
  if (a.durationMs && b.durationMs) {
    const drift = Math.abs(a.durationMs - b.durationMs);
    if (drift > 5000) score *= drift > 20000 ? 0.5 : 0.85;
  }

  return Math.min(1, score);
}

function tokenOverlap(a: string, b: string): number {
  if (a === b) return 1;
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return (2 * shared) / (setA.size + setB.size);
}

/** True when a ref carries enough to attempt playback at all. */
export function isPlayable(ref: MediaRef): boolean {
  return Boolean(ref.uri || ref.isrc || ref.mbid || ref.title);
}
