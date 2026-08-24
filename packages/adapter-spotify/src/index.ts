/**
 * Two ways to play Spotify, with honestly different capabilities.
 *
 * They are separate adapters rather than one adapter with a mode because they
 * genuinely are not the same backend. One needs no credentials and cannot
 * search; the other searches a hundred million tracks and needs a token, a
 * Premium account and a device that is awake. Collapsing that into a single
 * class would mean a `capabilities` object that is a lie half the time — which
 * is the exact failure this library exists to avoid.
 *
 * Registering both is a reasonable thing to do. They score the same on a
 * Spotify URI, so the runtime tries one and falls through to the other if it
 * cannot deliver: the desktop app when it is open, the Web API when it is not.
 */

export { SpotifyDesktopAdapter } from './desktop.js';
export type { SpotifyDesktopOptions } from './desktop.js';

export { SpotifyWebAdapter, toSample } from './web.js';
export type { SpotifyWebOptions } from './web.js';

export { SpotifyHttp } from './http.js';
export type { TokenProvider, SpotifyHttpOptions, RequestOptions } from './http.js';

export { SpotifyError, classifyStatus, classifyText } from './errors.js';
export type { SpotifyFailure } from './errors.js';

// Identity helpers, for hosts normalising links a person pasted.
export { parseSpotifyUri, toSpotifyUri, toSpotifyUrl, isPlayableKind } from './uri.js';
export type { SpotifyId, SpotifyKind } from './uri.js';

// The pure pieces, exported because they are the parts worth testing and worth
// reusing if you write a third Spotify backend of your own.
export { readTrack, searchQuery } from './ref.js';
export { interpret, initialWatchState } from './sampler.js';
export type { WatchState, InterpretOptions, Interpretation } from './sampler.js';
export { BackendWatcher } from './watch.js';
export type { BackendWatcherDeps } from './watch.js';
export {
  parseSample,
  stateScript,
  playTrackScript,
  commandScript,
  commands,
  runOsascript,
  FIELD,
} from './applescript.js';
export type { Sample, Osascript } from './applescript.js';

export { embedLookup, readEmbedHtml, clearMetadataCache } from './metadata.js';
export type { TrackLookup } from './metadata.js';
