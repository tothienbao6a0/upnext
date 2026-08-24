import { defaultCapabilities, systemScheduler, type Scheduler } from 'upnext-core';
import type { Adapter, AdapterEvent, Binding, Capabilities, MediaRef } from 'upnext-core';
import type { Sample } from './applescript.js';
import { SpotifyError } from './errors.js';
import { SpotifyHttp, type SpotifyHttpOptions, type TokenProvider } from './http.js';
import { readTrack, searchQuery } from './ref.js';
import { isPlayableKind, parseSpotifyUri, type SpotifyId } from './uri.js';
import { BackendWatcher } from './watch.js';

export interface SpotifyWebOptions extends SpotifyHttpOptions {
  id?: string;
  /**
   * Which device to command. Without one Spotify targets whatever is currently
   * active, which is usually right and occasionally surprising — a phone that
   * woke up last is as "active" as the laptop in front of you.
   */
  deviceId?: string;
  /**
   * How often to read player state while something is loaded.
   *
   * Slower than the desktop backend's default on purpose: every sample is a
   * real API call against a shared rate limit, and the host is using that same
   * budget for its own work. Two seconds is still well inside what a person
   * would call responsive for a progress bar.
   */
  sampleIntervalMs?: number;
  scheduler?: Scheduler;
  /** ISO 3166-1 alpha-2, so search and lookups return what this listener can play. */
  market?: string;
}

/**
 * Plays Spotify through the Web API, anywhere Node runs.
 *
 * The counterpart to `SpotifyDesktopAdapter`, and a deliberate demonstration of
 * why capabilities are a per-adapter fact rather than a per-service one: these
 * two drive the same service and are not interchangeable. This one can search a
 * catalogue of a hundred million tracks and runs on Linux; it also needs an
 * OAuth token, a Premium account and a device that is awake. The desktop one
 * needs none of that and cannot search at all.
 *
 * An agent does not have to know any of that. It asks `runtime.can('search')`
 * and gets the truth for whichever one is loaded.
 *
 * What the host has to provide:
 *
 *   - `getAccessToken`, returning a user token with `user-read-playback-state`
 *     and `user-modify-playback-state`. This library never runs an OAuth flow.
 *   - A Spotify Premium account. Every playback-control endpoint is Premium-only
 *     and there is nothing an adapter can do about that; a free account gets a
 *     `premium-required` failure rather than a mystery.
 *   - Somewhere to play. The Web API commands a device, it is not one — so the
 *     Spotify app has to be open somewhere, or `deviceId` has to name something
 *     real. `no-device` is the failure when it is not.
 */
export class SpotifyWebAdapter implements Adapter {
  readonly id: string;

  readonly capabilities: Capabilities = {
    ...defaultCapabilities,
    endOfTrack: 'event',
    position: 'authoritative',
    externalControl: true,
    seek: true,
    pause: true,
    volume: true,
    search: true,
  };

  #http: SpotifyHttp;
  #deviceId: string | undefined;
  #market: string | undefined;
  #watcher: BackendWatcher;

  #listeners = new Set<(event: AdapterEvent) => void>();
  #binding: Binding | null = null;
  #startAtMs = 0;
  #started = false;

  constructor(options: SpotifyWebOptions) {
    this.id = options.id ?? 'spotify-web';
    this.#http = new SpotifyHttp(options);
    this.#deviceId = options.deviceId;
    this.#market = options.market;

    const intervalMs = options.sampleIntervalMs ?? 2000;
    this.#watcher = new BackendWatcher({
      read: async () =>
        toSample(await this.#http.request('GET', '/me/player', { query: { market: this.#market } })),
      emit: (event) => this.#emit(event),
      scheduler: options.scheduler ?? systemScheduler,
      intervalMs,
      rolloverWindowMs: Math.max(3000, intervalMs * 2),
      confirmWithin: Math.max(3, Math.ceil(6000 / intervalMs)),
    });
  }

  /**
   * Prove the token works before the first song rather than during it.
   *
   * Reading player state is the right probe because it needs exactly the scope
   * everything else here needs, so a token that passes this has been checked
   * against the real requirement rather than a cheaper one. `204` — nothing
   * playing — is a pass: it means the call was authorised, which is all this
   * is asking.
   */
  async init(): Promise<void> {
    await this.#http.request('GET', '/me/player');
  }

  match(ref: MediaRef): number {
    const parsed = parseSpotifyUri(ref.uri);
    if (parsed) return isPlayableKind(parsed.kind) ? 1 : 0;
    // An ISRC is a recording id, so a search on it lands on the same recording
    // rather than something with a similar name — nearly as good as a URI.
    if (ref.isrc) return 0.9;
    if (ref.title) return 0.65;
    return 0;
  }

  async resolve(ref: MediaRef): Promise<Binding | null> {
    const parsed = parseSpotifyUri(ref.uri);
    const found = parsed ? await this.#byId(parsed) : await this.#bySearch(ref);
    if (!found?.uri) return null;

    return {
      adapterId: this.id,
      nativeUri: found.uri,
      // Spotify's copy wins here, unlike the desktop backend: this came from the
      // catalogue itself, so its duration and its ISRC are authoritative in a
      // way a caller's guess at a title is not. The caller's title survives only
      // where Spotify had nothing.
      ref: { ...ref, ...found },
    };
  }

  async search(query: string, limit = 10): Promise<MediaRef[]> {
    const body = await this.#http.request('GET', '/search', {
      query: { q: query, type: 'track', limit, market: this.#market },
    });
    return readTrackList(readPath(body, ['tracks', 'items']));
  }

  /**
   * Everything inside an album or a playlist, as refs.
   *
   * Not part of the `Adapter` contract, because a container is not a queue
   * entry — this runtime holds one item at a time and owns the ordering itself.
   * "Play my Discover Weekly" is therefore two steps, and they are two steps on
   * purpose: the host gets to see, filter and reorder the list before it becomes
   * a queue, rather than having thirty entries appear because one URI was
   * enqueued.
   *
   *     const tracks = await spotify.expandContext('spotify:playlist:37i9…');
   *     runtime.enqueueMany(tracks);
   */
  async expandContext(uri: string, limit = 100): Promise<MediaRef[]> {
    const parsed = parseSpotifyUri(uri);
    if (!parsed) return [];

    if (parsed.kind === 'album') {
      const body = await this.#http.request('GET', `/albums/${parsed.id}/tracks`, {
        query: { limit, market: this.#market },
      });
      return readTrackList(readPath(body, ['items']));
    }
    if (parsed.kind === 'playlist') {
      const body = await this.#http.request('GET', `/playlists/${parsed.id}/tracks`, {
        query: { limit, market: this.#market },
      });
      const items = readPath(body, ['items']);
      // A playlist wraps each track in an entry that also carries who added it
      // and when; the track itself is one level down.
      return Array.isArray(items)
        ? readTrackList(items.map((entry) => readPath(entry, ['track'])))
        : [];
    }
    return [];
  }

  async load(binding: Binding, opts?: { startAtMs?: number }): Promise<void> {
    this.#watcher.stop();
    this.#binding = binding;
    this.#startAtMs = opts?.startAtMs ?? 0;
    this.#started = false;
  }

  async play(): Promise<void> {
    const binding = this.#binding;
    if (!binding) throw new SpotifyError('failed', `${this.id}: nothing is loaded`);

    // With no body this is "resume"; with `uris` it is "play exactly this".
    // Handing it a single URI rather than a context is what keeps Spotify from
    // rolling into an album we did not queue when the track ends.
    const body = this.#started
      ? undefined
      : { uris: [binding.nativeUri], ...(this.#startAtMs > 0 ? { position_ms: this.#startAtMs } : {}) };

    await this.#http.request('PUT', '/me/player/play', {
      query: { device_id: this.#deviceId },
      ...(body ? { body } : {}),
    });
    this.#started = true;
    this.#watcher.start(binding.nativeUri);
  }

  async pause(): Promise<void> {
    await this.#http.request('PUT', '/me/player/pause', {
      query: { device_id: this.#deviceId },
    });
  }

  /**
   * The Web API has no stop, so this pauses — and tolerates being told it could
   * not. The runtime stops the outgoing backend on every transition, and by the
   * time that lands the device may already have moved on or gone to sleep;
   * Spotify answers that with a 403 "restriction violated". Failing a queue
   * transition because the thing we were stopping had already stopped would be
   * absurd.
   */
  async stop(): Promise<void> {
    this.#watcher.stop();
    const wasStarted = this.#started;
    this.#binding = null;
    this.#started = false;
    if (!wasStarted) return;
    await this.#http.request('PUT', '/me/player/pause', {
      query: { device_id: this.#deviceId },
      tolerate: [403, 404],
    });
  }

  async seek(positionMs: number): Promise<void> {
    await this.#http.request('PUT', '/me/player/seek', {
      query: { position_ms: Math.max(0, Math.round(positionMs)), device_id: this.#deviceId },
    });
  }

  async setVolume(volume: number): Promise<void> {
    await this.#http.request('PUT', '/me/player/volume', {
      query: {
        volume_percent: Math.min(100, Math.max(0, Math.round(volume * 100))),
        device_id: this.#deviceId,
      },
    });
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.#watcher.stop();
    this.#listeners.clear();
    this.#binding = null;
  }

  // -- resolution -----------------------------------------------------------

  async #byId(parsed: SpotifyId): Promise<MediaRef | null> {
    if (!isPlayableKind(parsed.kind)) return null;
    const path = parsed.kind === 'episode' ? `/episodes/${parsed.id}` : `/tracks/${parsed.id}`;
    try {
      return readTrack(await this.#http.request('GET', path, { query: { market: this.#market } }));
    } catch (err) {
      // A track Spotify does not have, or does not have here, is this adapter
      // answering "not me" — the runtime should try another source rather than
      // treat the entry as broken.
      if (err instanceof SpotifyError && err.reason === 'not-found') return null;
      throw err;
    }
  }

  async #bySearch(ref: MediaRef): Promise<MediaRef | null> {
    const query = searchQuery(ref);
    if (!query) return null;
    const hits = await this.search(query, 5);
    // The runtime scores this against what was asked for and rejects it if the
    // match is too loose, so returning the top hit is safe: a wrong guess is
    // caught one layer up rather than played.
    return hits[0] ?? null;
  }

  #emit(event: AdapterEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

/**
 * Player state as a `Sample`, so the Web API and the desktop app run through
 * the same interpretation.
 *
 * The two backends fail in different ways but the *question* is identical —
 * did our track end, or did a person take over — and it is subtle enough that
 * having one answer to it, tested once, is worth the small mapping here.
 *
 * A `204` (which arrives as `null`) means no active device: nothing is playing
 * and there is nowhere for it to play. That is the same situation as the
 * desktop app being closed, so it maps to the same `running: false`.
 */
export function toSample(body: unknown): Sample {
  if (!body || typeof body !== 'object') {
    return { running: false, status: 'idle', positionMs: 0, durationMs: null, nativeUri: null, volume: null };
  }
  const state = body as Record<string, unknown>;
  const item = state.item && typeof state.item === 'object' ? (state.item as Record<string, unknown>) : null;

  const durationMs = typeof item?.duration_ms === 'number' ? item.duration_ms : null;
  const progress = typeof state.progress_ms === 'number' ? state.progress_ms : 0;
  const device = state.device && typeof state.device === 'object' ? (state.device as Record<string, unknown>) : null;
  const volume = typeof device?.volume_percent === 'number' ? device.volume_percent : null;

  return {
    running: true,
    status: state.is_playing === true ? 'playing' : 'paused',
    positionMs: Number.isFinite(progress) && progress > 0 ? Math.round(progress) : 0,
    durationMs: durationMs !== null && Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : null,
    nativeUri: typeof item?.uri === 'string' ? item.uri : null,
    volume: volume === null ? null : Math.min(1, Math.max(0, volume / 100)),
  };
}

function readTrackList(value: unknown): MediaRef[] {
  if (!Array.isArray(value)) return [];
  const out: MediaRef[] = [];
  for (const entry of value) {
    const ref = readTrack(entry);
    if (ref) out.push(ref);
  }
  return out;
}

function readPath(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export type { TokenProvider };
