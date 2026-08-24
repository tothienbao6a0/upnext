/**
 * Why a Spotify call did not work, in the few shapes a caller can act on.
 *
 * The distinction that matters is not the status code — it is what the person
 * holding the machine would have to *do*. "Your token expired" and "you have no
 * speaker selected" are both a failed play, and an agent that cannot tell them
 * apart either nags for a re-login when the real problem is a sleeping phone,
 * or silently retries forever when the real problem is a login.
 *
 * The shape and the coarseness are lifted from the same classification in the
 * user's superapp (`spotify-service.ts`), for the reason given there: the exact
 * wording of an upstream error is not a contract and will drift, so this keys
 * off the few stable signals and buckets everything else as `failed`.
 */
export type SpotifyFailure =
  /** No usable session. The host must get a fresh token, or the user must log in. */
  | 'unauthorized'
  /** Authenticated, but Spotify will not let this account control playback. */
  | 'premium-required'
  /** Nothing to play *on*: no active device, or the desktop app is not running. */
  | 'no-device'
  /** Too many calls. Back off; `retryAfterMs` says how long if Spotify said. */
  | 'rate-limited'
  /** Spotify does not have this track, or not in this market. */
  | 'not-found'
  /** This backend cannot run here at all — wrong platform, app not installed. */
  | 'unavailable'
  /** Something else. Renders as "try again", the safe default when unsure. */
  | 'failed';

export class SpotifyError extends Error {
  readonly reason: SpotifyFailure;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    reason: SpotifyFailure,
    message: string,
    extra: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'SpotifyError';
    this.reason = reason;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

/**
 * Map an HTTP status, plus Spotify's own `reason` when it sends one, onto a
 * bucket.
 *
 * Two statuses are genuinely ambiguous and the body is what settles them:
 * a 403 is a scope problem *or* a free account, and a 404 from the player
 * endpoints is a missing track *or* the well-known `NO_ACTIVE_DEVICE`. Both
 * distinctions change what a host should tell the user, so both are read.
 */
export function classifyStatus(status: number, body?: unknown): SpotifyFailure {
  const reason = errorReason(body);
  if (status === 429) return 'rate-limited';
  if (status === 401) return 'unauthorized';
  if (status === 403) {
    return reason === 'PREMIUM_REQUIRED' ? 'premium-required' : 'unauthorized';
  }
  if (status === 404) {
    return reason === 'NO_ACTIVE_DEVICE' ? 'no-device' : 'not-found';
  }
  return 'failed';
}

/** Spotify's player errors carry `{ error: { status, message, reason } }`. */
function errorReason(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}

/** Spotify's error body carries a human message worth passing through. */
export function errorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return fallback;
}

/**
 * The same classification against free text, for the backend that has no status
 * codes — osascript writes prose to stderr and nothing else.
 *
 * Ported from superapp's `classify`, including the ordering: rate limiting is
 * tested first because a throttling message can contain the word "user" and
 * must not be mistaken for the auth case below it.
 */
export function classifyText(text: string): SpotifyFailure {
  const lower = text.toLowerCase();
  if (/rate limit|too many|429/.test(lower)) return 'rate-limited';
  if (/not authorized|not authorised|-1743|assistive access/.test(lower)) {
    // macOS Automation consent was declined. Not a Spotify login problem, but
    // it is the same shape of problem: a permission the user has to grant.
    return 'unauthorized';
  }
  if (/(-600|-609)|isn't running|is not running|application isn't/.test(lower)) {
    return 'no-device';
  }
  if (/can't get|cant get|-1728/.test(lower)) return 'not-found';
  return 'failed';
}

/** Seconds in a `Retry-After` header, in milliseconds. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
