export { NowPlayingAdapter, NOW_PLAYING_URI } from './adapter.js';
export type { NowPlayingAdapterOptions } from './adapter.js';

// The platform-dispatching versions. On macOS these are exactly the
// MediaRemote ones; on Linux they reach MPRIS. A caller should not have to ask.
export { readNowPlaying, sendTransport, isAvailable } from './source.js';
export { COMMANDS } from './mediaremote.js';
export type { TransportCommand } from './mediaremote.js';

// Still reachable by their platform-specific names, for anyone who genuinely
// wants one register rather than "whatever this machine has".
export {
  readNowPlaying as readMediaRemote,
  sendTransport as sendMediaRemote,
  isAvailable as mediaRemoteAvailable,
} from './mediaremote.js';

export { parseReading, readingUri, hasEnded } from './reading.js';
export type { NowPlayingReading } from './reading.js';

export { sourceFor } from './source.js';
export type { NowPlayingSource } from './source.js';
export { parseMpris, readMpris, mprisAvailable, FORMAT as MPRIS_FORMAT } from './mpris.js';
