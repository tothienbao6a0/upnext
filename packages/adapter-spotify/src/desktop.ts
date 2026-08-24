import { defaultCapabilities, systemScheduler, type Scheduler } from 'upnext-core';
import type { Adapter, AdapterEvent, Binding, Capabilities, MediaRef } from 'upnext-core';
import {
  commandScript,
  commands,
  parseSample,
  playTrackScript,
  runOsascript,
  stateScript,
  type Osascript,
} from './applescript.js';
import { SpotifyError } from './errors.js';
import { embedLookup, type TrackLookup } from './metadata.js';
import { isPlayableKind, parseSpotifyUri, toSpotifyUri } from './uri.js';
import { BackendWatcher } from './watch.js';

export interface SpotifyDesktopOptions {
  id?: string;
  /**
   * How often to read the app while something is loaded.
   *
   * This is the resolution of every time-dependent thing the backend can tell
   * us — the playhead, a pause someone made in the app, the end of a track.
   * A second is comfortably below what a person notices and cheap enough to
   * run for hours; the cost of each sample is one short-lived `osascript`.
   */
  sampleIntervalMs?: number;
  /** Injected so the whole adapter is testable off macOS. */
  osascript?: Osascript;
  scheduler?: Scheduler;
  /**
   * How a bare Spotify URI becomes a title and a cover. `null` turns it off and
   * the queue simply shows URIs — nothing about playback depends on it.
   */
  lookup?: TrackLookup | null;
  /** Overridden only by tests; a real host is on whatever it is on. */
  platform?: string;
}

/**
 * Drives the Spotify desktop app on macOS, with no credentials at all.
 *
 * There is no OAuth here, no client id, no Premium check and nothing to
 * register: it talks to the copy of Spotify already running on the machine
 * through the AppleScript dictionary that ships with it. If someone can play
 * music in Spotify, this can play music in Spotify.
 *
 * It is also the first backend in this project that a **human can fight**, and
 * that is the interesting part. A local file is ours alone; the Spotify app has
 * its own transport bar, its own queue, and a person holding a phone who is
 * fully entitled to press next. So it declares `externalControl: true`, keeps
 * enough history to tell a natural track change from a deliberate one (see
 * `sampler.ts`), and lets the runtime's reconciler decide who wins — which by
 * default is the person.
 *
 * What it deliberately does *not* claim:
 *
 *   `search: false` — the dictionary cannot search the catalogue. It could be
 *     faked by scraping something, and then every `resolve` of a title would be
 *     a guess dressed as a lookup. An adapter that says it cannot do a thing is
 *     correct and slightly limited; one that says it can and then does it badly
 *     is broken. Use `SpotifyWebAdapter` when you need search.
 *
 *   No `poll()` — `position: 'authoritative'` would normally make the runtime's
 *     watcher poll this adapter on an interval. It samples itself instead,
 *     because only the adapter can compare a reading against the one before it,
 *     and that comparison is the whole rollover-versus-takeover decision.
 *     Offering `poll` as well would mean two timers reading the same app.
 */
export class SpotifyDesktopAdapter implements Adapter {
  readonly id: string;

  readonly capabilities: Capabilities = {
    ...defaultCapabilities,
    endOfTrack: 'event',
    position: 'authoritative',
    externalControl: true,
    seek: true,
    pause: true,
    volume: true,
    search: false,
  };

  #osascript: Osascript;
  #lookup: TrackLookup | null;
  #platform: string;
  #watcher: BackendWatcher;

  #listeners = new Set<(event: AdapterEvent) => void>();
  #binding: Binding | null = null;
  #startAtMs = 0;
  /** Whether `play track` has been issued for the loaded binding. */
  #started = false;

  constructor(options: SpotifyDesktopOptions = {}) {
    this.id = options.id ?? 'spotify-desktop';
    this.#osascript = options.osascript ?? runOsascript;
    this.#lookup = options.lookup === undefined ? embedLookup : options.lookup;
    this.#platform = options.platform ?? process.platform;

    const intervalMs = options.sampleIntervalMs ?? 1000;
    this.#watcher = new BackendWatcher({
      read: async () => parseSample(await this.#osascript(stateScript())),
      emit: (event) => this.#emit(event),
      scheduler: options.scheduler ?? systemScheduler,
      intervalMs,
      // Two intervals wide: the last reading before a track change can be a
      // whole interval short of the end, and a window tighter than that reads
      // every natural rollover as a human taking over.
      rolloverWindowMs: Math.max(2000, intervalMs * 2),
      confirmWithin: Math.max(3, Math.ceil(5000 / intervalMs)),
    });
  }

  /**
   * Fail here rather than at the first song.
   *
   * A backend whose `init` throws is excluded from selection and shows up in
   * `getState().adapters` as `available: false` with the reason — so a host on
   * Linux gets one clear "this backend is macOS-only" at startup instead of an
   * agent discovering it one failed track at a time.
   *
   * `id of application "Spotify"` resolves the app through LaunchServices
   * *without launching it*, which is the only way to ask "is Spotify even
   * installed" that does not open a music player on someone's desktop.
   */
  async init(): Promise<void> {
    if (this.#platform !== 'darwin') {
      throw new SpotifyError(
        'unavailable',
        `${this.id} drives the macOS Spotify app and cannot run on ${this.#platform}; ` +
          'use SpotifyWebAdapter instead',
      );
    }
    try {
      await this.#osascript('id of application "Spotify"');
    } catch (err) {
      throw new SpotifyError(
        'unavailable',
        `${this.id} could not find the Spotify desktop app: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Only things that already name a Spotify track.
   *
   * Without search there is no way to get from "Bad Habit by Steve Lacy" to a
   * URI, so scoring anything else above zero would win the ref away from an
   * adapter that could actually have played it.
   */
  match(ref: MediaRef): number {
    const parsed = parseSpotifyUri(ref.uri);
    return parsed && isPlayableKind(parsed.kind) ? 1 : 0;
  }

  async resolve(ref: MediaRef): Promise<Binding | null> {
    const parsed = parseSpotifyUri(ref.uri);
    if (!parsed || !isPlayableKind(parsed.kind)) return null;
    const nativeUri = toSpotifyUri(parsed);

    // Best-effort only, and skipped entirely when the ref already says enough.
    // A track with no title still plays; a resolve that throws does not.
    let extra: Partial<MediaRef> = {};
    if (this.#lookup && !(ref.title && ref.artist)) {
      try {
        extra = await this.#lookup(parsed);
      } catch {
        extra = {};
      }
    }

    return {
      adapterId: this.id,
      nativeUri,
      // What the caller already knew wins: it came from whoever built the
      // queue, and the lookup is only filling gaps.
      ref: { ...extra, ...ref, uri: nativeUri },
    };
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

    if (this.#started) {
      // Resuming what is already loaded. `play` on its own is the dictionary's
      // resume; re-issuing `play track` would restart the song from zero.
      await this.#run(commandScript(commands.play));
      return;
    }

    await this.#run(playTrackScript(binding.nativeUri, this.#startAtMs));
    this.#started = true;
    this.#watcher.start(binding.nativeUri);
  }

  async pause(): Promise<void> {
    await this.#run(commandScript(commands.pause));
  }

  /**
   * Spotify's dictionary has no stop that does not quit the app, so this
   * pauses. Quitting somebody's music player because the queue moved on to a
   * podcast would be a much bigger thing to do than the runtime is asking for.
   */
  async stop(): Promise<void> {
    this.#watcher.stop();
    const wasStarted = this.#started;
    this.#binding = null;
    this.#started = false;
    if (wasStarted) await this.#run(commandScript(commands.pause));
  }

  async seek(positionMs: number): Promise<void> {
    await this.#run(commandScript(commands.seek(positionMs)));
  }

  async setVolume(volume: number): Promise<void> {
    await this.#run(commandScript(commands.volume(volume)));
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

  async #run(script: string): Promise<void> {
    await this.#osascript(script);
  }

  #emit(event: AdapterEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}
