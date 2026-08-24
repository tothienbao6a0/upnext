/**
 * Reading Spotify's two ways of naming the same thing.
 *
 * A ref can arrive carrying either form — `spotify:track:6f3Slt0GbA2bPZlz0aIFXN`
 * from an API, or `https://open.spotify.com/track/6f3Slt0GbA2bPZlz0aIFXN?si=…`
 * from a person pasting a share link — and both adapters have to treat them as
 * the same track. Everything downstream works in the `spotify:` form, because
 * that is what the AppleScript dictionary and the Web API both accept.
 *
 * Parsing is total: anything unrecognised answers `null` rather than throwing,
 * so `match` can score a ref without a try/catch around it.
 */

export type SpotifyKind = 'track' | 'episode' | 'album' | 'playlist' | 'artist' | 'show';

export interface SpotifyId {
  kind: SpotifyKind;
  /** The base-62 id, without any prefix. */
  id: string;
}

const KINDS = new Set<string>(['track', 'episode', 'album', 'playlist', 'artist', 'show']);

/**
 * Kinds that name one playable item.
 *
 * The rest are *containers*, and a container is not a queue entry — this
 * library's whole shape is one item at a time, with the ordering owned above
 * the backend. An album URI is a request to enqueue many things, which is
 * `expandContext` plus `enqueueMany`, not a single bind.
 */
export function isPlayableKind(kind: SpotifyKind): boolean {
  return kind === 'track' || kind === 'episode';
}

/** Spotify ids are base-62. Length is not pinned: it is 22 today, and a format
 * check that is wrong in two years is worse than one that is slightly loose. */
const ID = /^[A-Za-z0-9]{8,64}$/;

export function parseSpotifyUri(value: string | undefined | null): SpotifyId | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase().startsWith('spotify:')
    ? fromUri(trimmed)
    : fromUrl(trimmed);
}

/**
 * `spotify:track:ID`, and the legacy `spotify:user:someone:playlist:ID`.
 *
 * Scanning from the right rather than reading position 1 is what handles the
 * legacy form, and it costs nothing on the common one. `spotify:local:…` has no
 * base-62 id at all and falls out on its own — which is correct, since a local
 * file in someone's Spotify library is not something either backend can locate.
 */
function fromUri(value: string): SpotifyId | null {
  const parts = value.split(':');
  for (let i = parts.length - 2; i >= 0; i--) {
    const kind = parts[i]?.toLowerCase();
    const id = parts[i + 1];
    if (kind && KINDS.has(kind) && id && ID.test(id)) {
      return { kind: kind as SpotifyKind, id };
    }
  }
  return null;
}

/**
 * `https://open.spotify.com/track/ID`, with or without a locale segment.
 *
 * The locale form (`/intl-de/track/ID`) is what the mobile app produces when
 * someone shares from a non-English device, so it is not an edge case — it is
 * half of the share links a person will actually paste. Scanning the path for a
 * known kind absorbs it, and the legacy `play.spotify.com` host, without a
 * pattern per variant.
 */
function fromUrl(value: string): SpotifyId | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!/(^|\.)spotify\.com$/i.test(url.hostname)) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    const kind = segments[i]?.toLowerCase();
    const id = segments[i + 1];
    if (kind && KINDS.has(kind) && id && ID.test(id)) {
      return { kind: kind as SpotifyKind, id };
    }
  }
  return null;
}

export function toSpotifyUri(parsed: SpotifyId): string {
  return `spotify:${parsed.kind}:${parsed.id}`;
}

export function toSpotifyUrl(parsed: SpotifyId): string {
  return `https://open.spotify.com/${parsed.kind}/${parsed.id}`;
}
