import type { MediaRef } from 'upnext-core';

/**
 * Spotify's track JSON, read defensively into a `MediaRef`.
 *
 * Every field is checked rather than trusted. This is a network payload from a
 * service that has changed its shapes before, and the difference between a
 * missing field and a wrong one is the difference between a queue row with no
 * cover and a `durationMs` of `NaN` — which the runtime would treat as a real
 * duration and use to decide the track was over.
 *
 * The one field worth going out of the way for is `external_ids.isrc`. It is
 * the recording-level id, and carrying it is what lets the same queue entry be
 * found in someone else's Apple Music library, or fall back to a local file, or
 * be handed to a completely different adapter when this one is unavailable. A
 * Spotify URI identifies a row in Spotify's catalogue; an ISRC identifies the
 * song.
 */
export function readTrack(value: unknown): MediaRef | null {
  if (!value || typeof value !== 'object') return null;
  const track = value as Record<string, unknown>;

  const uri = text(track.uri);
  const title = text(track.name);
  if (!uri && !title) return null;

  const ref: MediaRef = {};
  if (title) ref.title = title;
  if (uri) ref.uri = uri;

  const artist = readArtists(track.artists);
  if (artist) ref.artist = artist;

  const album = track.album;
  if (album && typeof album === 'object') {
    const name = text((album as Record<string, unknown>).name);
    if (name) ref.album = name;
    const artwork = pickImage((album as Record<string, unknown>).images);
    if (artwork) ref.artwork = artwork;
  }

  // A podcast episode has no album and no artists: its cover hangs off the
  // episode itself and its "artist" is the show. Reading both here is what
  // stops an episode from arriving in the queue as a bare URI.
  if (!ref.artwork) {
    const artwork = pickImage(track.images);
    if (artwork) ref.artwork = artwork;
  }
  if (!ref.artist) {
    const show = track.show;
    if (show && typeof show === 'object') {
      const name = text((show as Record<string, unknown>).name);
      if (name) ref.artist = name;
    }
  }

  const durationMs = track.duration_ms;
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
    ref.durationMs = Math.round(durationMs);
  }

  const isrc = readIsrc(track.external_ids);
  if (isrc) ref.isrc = isrc;

  return ref;
}

/**
 * Artists as a comma-joined line.
 *
 * Handles both shapes on purpose. The Web API returns objects with a `name`;
 * tools that normalise Spotify's payloads — spogo among them — flatten the same
 * field to plain strings. Accepting either costs three lines and means this
 * function is reusable by an out-of-process adapter that went through one of
 * them.
 */
function readArtists(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const names = value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object') {
        return text((entry as Record<string, unknown>).name) ?? '';
      }
      return '';
    })
    .filter(Boolean);
  return names.length > 0 ? names.join(', ') : null;
}

function readIsrc(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const isrc = (value as Record<string, unknown>).isrc;
  return typeof isrc === 'string' && /^[A-Za-z0-9]{12}$/.test(isrc.trim())
    ? isrc.trim().toUpperCase()
    : null;
}

/** The smallest cover at least 300px wide, or the largest on offer. */
function pickImage(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const sized: Array<{ url: string; width: number }> = [];
  for (const image of value) {
    if (!image || typeof image !== 'object') continue;
    const record = image as Record<string, unknown>;
    const url = text(record.url);
    if (!url?.startsWith('https://')) continue;
    sized.push({ url, width: typeof record.width === 'number' ? record.width : 0 });
  }
  if (sized.length === 0) return null;
  const enough = sized.filter((entry) => entry.width >= 300).sort((a, b) => a.width - b.width);
  return enough[0]?.url ?? [...sized].sort((a, b) => b.width - a.width)[0]?.url ?? null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * A search query in Spotify's field syntax.
 *
 * Quoted fields rather than a bare concatenation, because "Bad Habit Steve
 * Lacy" as free text returns covers and remixes above the original often
 * enough to matter, and the runtime is going to score whatever comes back
 * against what was asked for and reject it if it does not match closely enough.
 * A tighter query means fewer of those rejections.
 */
export function searchQuery(ref: MediaRef): string | null {
  if (ref.isrc) return `isrc:${ref.isrc}`;
  const parts: string[] = [];
  if (ref.title) parts.push(`track:"${escapeQuery(ref.title)}"`);
  if (ref.artist) parts.push(`artist:"${escapeQuery(primary(ref.artist))}"`);
  if (ref.album && !ref.artist) parts.push(`album:"${escapeQuery(ref.album)}"`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Only the first credited artist: a featuring credit spelled differently on
 * two services turns an exact-match query into a miss. */
function primary(artist: string): string {
  return artist.split(/,| feat\.? | ft\.? | & /i)[0]?.trim() || artist;
}

function escapeQuery(value: string): string {
  return value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}
