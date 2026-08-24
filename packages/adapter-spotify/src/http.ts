import { SpotifyError, classifyStatus, errorMessage, retryAfterMs } from './errors.js';

/**
 * Where the access token comes from — which is to say, not from here.
 *
 * This library holds no client id, runs no OAuth flow, opens no browser and
 * stores no refresh token. That is the same boundary the core draws around
 * `resolveIntent`: a library that acquires credentials has decided which
 * provider you use, where the redirect lands and what your token storage looks
 * like, and none of those are its business.
 *
 * So the host supplies a function. It can return a cached token, hit its own
 * refresh endpoint, or read one out of a config file — the adapter only asks
 * again when the one it has stops working.
 */
export type TokenProvider = () => string | Promise<string>;

export interface SpotifyHttpOptions {
  getAccessToken: TokenProvider;
  /** Injected for tests, and for hosts that route their traffic somewhere. */
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Statuses to answer `null` for instead of throwing. */
  tolerate?: number[];
}

/**
 * One authenticated call to the Web API, with the two failures that actually
 * happen handled in one place.
 *
 * **Expiry.** Tokens last an hour and a queue outlives that easily, so a 401 is
 * a normal event, not an error. It triggers exactly one re-ask and one retry.
 * One, because a provider that keeps returning a dead token would otherwise
 * spin forever, and the second failure is the honest answer: this host cannot
 * currently authenticate.
 *
 * **Concurrency.** Lookahead resolves several entries at once, so several calls
 * can hit a 401 together. Without the single-flight below they would each fetch
 * a token, which at best wastes refreshes and at worst trips the host's own
 * rate limit at the exact moment everything is already failing. The pattern is
 * from superapp's `SpotifyService.importing`, for the same reason: a second
 * caller should adopt the first's work rather than start its own.
 */
export class SpotifyHttp {
  #getAccessToken: TokenProvider;
  #fetch: typeof globalThis.fetch;
  #baseUrl: string;

  #token: string | null = null;
  #fetching: Promise<string> | null = null;

  constructor(options: SpotifyHttpOptions) {
    this.#getAccessToken = options.getAccessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? 'https://api.spotify.com/v1').replace(/\/$/, '');
  }

  async request(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const response = await this.#send(method, path, options, await this.#authorize(false));
    if (response.status !== 401) return this.#read(response, options);

    // The token died mid-queue. Get another and try exactly once more.
    const retry = await this.#send(method, path, options, await this.#authorize(true));
    return this.#read(retry, options);
  }

  /** Drop the cached token, so the next call asks the host for a new one. */
  invalidate(): void {
    this.#token = null;
  }

  async #send(
    method: string,
    path: string,
    options: RequestOptions,
    token: string,
  ): Promise<Response> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    try {
      return await this.#fetch(url.toString(), {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (err) {
      // DNS, a dropped connection, an offline laptop. Not an auth problem and
      // not something a retry here would fix — the runtime will fall through to
      // another adapter, which is the correct response to "Spotify is
      // unreachable right now".
      throw new SpotifyError(
        'failed',
        `could not reach the Spotify Web API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async #read(response: Response, options: RequestOptions): Promise<unknown> {
    // 204 is Spotify's answer to most player commands, and to "nothing is
    // playing" on the player endpoint. It is a success with nothing in it.
    if (response.status === 204 || options.tolerate?.includes(response.status)) return null;

    const body = await readJson(response);
    if (response.ok) return body;

    const reason = classifyStatus(response.status, body);
    throw new SpotifyError(reason, errorMessage(body, `Spotify returned ${response.status}`), {
      status: response.status,
      ...(reason === 'rate-limited'
        ? { retryAfterMs: retryAfterMs(response.headers.get('retry-after')) }
        : {}),
    });
  }

  async #authorize(force: boolean): Promise<string> {
    if (!force && this.#token) return this.#token;
    if (this.#fetching) return this.#fetching;

    this.#fetching = (async () => {
      const token = await this.#getAccessToken();
      if (typeof token !== 'string' || !token.trim()) {
        throw new SpotifyError('unauthorized', 'getAccessToken did not return an access token');
      }
      return token.trim();
    })();

    try {
      this.#token = await this.#fetching;
      return this.#token;
    } finally {
      this.#fetching = null;
    }
  }
}

/** A body that is not JSON is not worth failing over — the status already said
 * what happened, and the parsed body only ever adds detail. */
async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
