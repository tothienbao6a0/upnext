import type { MediaRef } from 'upnext-core';
import { toSpotifyUri, type SpotifyId } from './uri.js';

/**
 * Turning a bare Spotify id into a title, an artist and a cover, without a
 * token.
 *
 * The desktop backend needs this and the Web API backend does not. Spotify's
 * AppleScript dictionary can only describe a track once it is *playing*, so a
 * queue built from share links would show a column of raw URIs right up until
 * each one started — which is the queue being useless for the one thing a queue
 * is for, seeing what is coming.
 *
 * How it works, stated plainly because it matters: `open.spotify.com/embed/…`
 * is the public embed player, and the page carries the track's metadata in a
 * `__NEXT_DATA__` script tag. It needs no credentials, which is the whole
 * point, but it is **not a documented API** — it is a page built for a browser,
 * and Spotify can change its markup whenever it likes.
 *
 * So it is treated as a nicety, never a dependency: every failure answers an
 * empty object, a lookup is skipped entirely when the ref already has what it
 * needs, and a host that would rather not reach the network at all passes
 * `lookup: null`. Nothing about whether a track *plays* runs through here.
 *
 * The mechanism, the `__NEXT_DATA__` walk and the cover-picking are adapted
 * from the user's superapp (`spotify-queue.ts`), which uses it for the same
 * reason — its queue source also returns ids with the names stripped out.
 */
export type TrackLookup = (id: SpotifyId) => Promise<Partial<MediaRef>>;

const EMPTY: Partial<MediaRef> = {};

/**
 * Facts resolved once, kept for the life of the process.
 *
 * A title is a property of the track, not of this lookup, and a poll-driven
 * queue re-reads the same entries repeatedly. Caching by URI turns a settled
 * queue into zero network calls after the first pass.
 *
 * Only non-empty results are cached: a failed lookup should retry on the next
 * pass rather than freezing a track as nameless for the whole session.
 */
const cache = new Map<string, Partial<MediaRef>>();

/** Everything the queue would want to show, from the public embed page. */
export const embedLookup: TrackLookup = async (parsed) => {
  const uri = toSpotifyUri(parsed);
  const hit = cache.get(uri);
  if (hit) return hit;

  const facts = await fetchEmbed(parsed);
  if (Object.keys(facts).length > 0) cache.set(uri, facts);
  return facts;
};

/** Drop everything remembered. Exported for tests; a host has no reason to. */
export function clearMetadataCache(): void {
  cache.clear();
}

async function fetchEmbed(parsed: SpotifyId): Promise<Partial<MediaRef>> {
  try {
    const response = await fetch(
      `https://open.spotify.com/embed/${parsed.kind}/${encodeURIComponent(parsed.id)}`,
      // The page varies its markup for a bare client, so it is asked for the
      // way a browser would ask.
      { headers: { 'user-agent': 'Mozilla/5.0' } },
    );
    if (!response.ok) return EMPTY;
    return readEmbedHtml(await response.text());
  } catch {
    // Offline, DNS, a redirect loop, a changed page — all the same answer. A
    // track with no title still plays.
    return EMPTY;
  }
}

/**
 * Split from the fetch and exported so the fragile half — the shape of a page
 * we do not control — is covered by a test holding a real captured payload,
 * with no network in it.
 */
export function readEmbedHtml(html: string): Partial<MediaRef> {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s,
  );
  if (!match?.[1]) return EMPTY;

  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return EMPTY;
  }

  const entity = readPath(data, ['props', 'pageProps', 'state', 'data', 'entity']);
  if (!entity || typeof entity !== 'object') return EMPTY;
  const record = entity as Record<string, unknown>;

  const out: Partial<MediaRef> = {};

  const title = text(record.title) ?? text(record.name);
  if (title) out.title = title;

  const artist = Array.isArray(record.artists)
    ? record.artists
        .map((entry) =>
          entry && typeof entry === 'object'
            ? (text((entry as Record<string, unknown>).name) ?? '')
            : '',
        )
        .filter(Boolean)
        .join(', ')
    : '';
  if (artist) out.artist = artist;

  const duration = record.duration;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
    out.durationMs = Math.round(duration);
  }

  const visual =
    record.visualIdentity && typeof record.visualIdentity === 'object'
      ? (record.visualIdentity as Record<string, unknown>)
      : {};
  const artwork = pickCover(visual.image);
  if (artwork) out.artwork = artwork;

  return out;
}

/**
 * The cover closest to the size a list actually draws: the smallest source at
 * least 300px wide, or the largest on offer if none reach that.
 */
function pickCover(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  const sized: Array<{ url: string; width: number }> = [];
  for (const image of images) {
    if (!image || typeof image !== 'object') continue;
    const record = image as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url : '';
    if (!url.startsWith('https://')) continue;
    const width = typeof record.maxWidth === 'number' ? record.maxWidth : 0;
    sized.push({ url, width });
  }
  if (sized.length === 0) return null;

  const enough = sized.filter((entry) => entry.width >= 300).sort((a, b) => a.width - b.width);
  if (enough[0]) return enough[0].url;
  return [...sized].sort((a, b) => b.width - a.width)[0]?.url ?? null;
}

/** Walk a chain of keys through untrusted JSON, stopping at the first step that
 * is not an object rather than throwing. */
function readPath(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
