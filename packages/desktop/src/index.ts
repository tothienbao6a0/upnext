import { Runtime, type Adapter, type RuntimeOptions } from 'upnext-core';
import { LocalAdapter } from 'upnext-adapter-local';
import { MediaElementAdapter, type MediaElementLike } from 'upnext-adapter-browser';
import { NowPlayingAdapter } from 'upnext-adapter-nowplaying';
import { SpotifyDesktopAdapter, SpotifyWebAdapter } from 'upnext-adapter-spotify';

export interface DesktopOptions extends Omit<RuntimeOptions, 'adapters'> {
  /**
   * Folders to index so a bare title can find a local file.
   *
   * Worth setting: without either this or `spotifyToken`, nothing on the
   * machine can turn "Bad Habit" into something playable. See `explainSetup`.
   */
  library?: string[];
  /**
   * Supply a Spotify Web API token and you get catalogue search — the ability
   * to resolve a title you do not already have a link for.
   */
  spotifyToken?: () => Promise<string>;
  /** A media element, when the host has one: a browser, or an Electron renderer. */
  element?: MediaElementLike | (() => MediaElementLike);
  /** Leave out an adapter you do not want, by id. */
  exclude?: string[];
}

/**
 * Every source this machine can reach, in one call.
 *
 * The library proper asks you to choose and wire adapters, because a library
 * that guesses is a library you cannot use in the case it guessed wrong. This
 * is the other end of that: for the common case — someone on a laptop who wants
 * audio to work — guessing well is the entire value.
 *
 * Nothing here is unavailable to you individually; this only saves the wiring.
 */
export async function desktop(options: DesktopOptions = {}): Promise<Runtime> {
  const { library, spotifyToken, element, exclude = [], ...runtimeOptions } = options;
  const adapters: Adapter[] = [];

  if (spotifyToken) adapters.push(new SpotifyWebAdapter({ getAccessToken: spotifyToken }));

  if (process.platform === 'darwin') {
    // Ahead of the web backend for playback it can also do, because it needs no
    // credentials and no network — but behind it for *resolution*, which it
    // cannot do at all. The binder sorts that out per entry.
    adapters.push(new SpotifyDesktopAdapter());
    adapters.push(new NowPlayingAdapter());
  }

  if (element) adapters.push(new MediaElementAdapter({ element }));

  adapters.push(new LocalAdapter(library?.length ? { library } : {}));

  const runtime = new Runtime({
    ...runtimeOptions,
    adapters: adapters.filter((adapter) => !exclude.includes(adapter.id)),
  });

  // Adapters report availability asynchronously — a Spotify that is not
  // installed, a macOS framework that is gated. Waiting a moment here means
  // `explainSetup` tells the truth on the first call rather than the second.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return runtime;
}

export interface SetupSummary {
  /** Adapters that came up, with what each can do. */
  available: Array<{ id: string; canSearch: boolean; canSeek: boolean }>;
  /** Registered but not usable here, and why. */
  unavailable: Array<{ id: string; reason: string }>;
  /**
   * Whether anything can turn a bare title into something playable.
   *
   * The one question worth asking of a setup, and the one nobody thinks to ask
   * until `enqueue({ title })` quietly fails.
   */
  canResolveTitles: boolean;
}

export function summariseSetup(runtime: Runtime): SetupSummary {
  const adapters = runtime.getState().adapters;
  return {
    available: adapters
      .filter((a) => a.available)
      .map((a) => ({ id: a.id, canSearch: a.capabilities.search, canSeek: a.capabilities.seek })),
    unavailable: adapters
      .filter((a) => !a.available)
      .map((a) => ({ id: a.id, reason: a.error?.message ?? 'unknown' })),
    canResolveTitles: adapters.some((a) => a.available && a.capabilities.search),
  };
}

/**
 * The same thing, for a human to read.
 *
 * Exists because the failure it warns about is silent: you wire up a Mac with
 * Spotify running, `enqueue('spotify:track:…')` works perfectly, and then
 * `enqueue({ title: 'Bad Habit' })` does nothing — because the desktop app's
 * AppleScript dictionary cannot search a catalogue, and nothing else you wired
 * can either. That is a correct outcome and an baffling one, so say it out loud.
 */
export function explainSetup(runtime: Runtime): string {
  const summary = summariseSetup(runtime);
  const lines: string[] = [];

  lines.push(`playing through: ${summary.available.map((a) => a.id).join(', ') || 'nothing'}`);
  for (const { id, reason } of summary.unavailable) lines.push(`unavailable: ${id} — ${reason}`);

  if (summary.canResolveTitles) {
    const searchers = summary.available.filter((a) => a.canSearch).map((a) => a.id);
    lines.push(`titles resolve via: ${searchers.join(', ')}`);
  } else {
    lines.push(
      'titles will NOT resolve: nothing wired here can search. ' +
        'enqueue() a link or a file path, or pass `library` or `spotifyToken` — ' +
        'or supply `resolveIntent` and answer it yourself.',
    );
  }

  return lines.join('\n');
}

export { Runtime } from 'upnext-core';
export type { MediaElementLike } from 'upnext-adapter-browser';
export { NOW_PLAYING_URI, readNowPlaying, sendTransport } from 'upnext-adapter-nowplaying';
