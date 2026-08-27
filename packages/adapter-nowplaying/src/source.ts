import { isAvailable as macAvailable, readNowPlaying as macRead, sendTransport as macSend } from './mediaremote.js';
import { mprisAvailable, readMpris, sendMpris } from './mpris.js';
import type { NowPlayingReading } from './reading.js';

/**
 * Which system register to ask, on this machine.
 *
 * macOS and Linux answer the same question through completely different
 * plumbing — a private Apple framework reached through JXA, and a D-Bus
 * interface reached through `playerctl`. A host should not have to care, and
 * neither should the queue: `nowplaying:current` means the same thing on both.
 *
 * Windows has an equivalent in SMTC and is not implemented. It would slot in
 * here, and nothing above this file would change.
 */
export interface NowPlayingSource {
  readonly platform: string;
  available(): Promise<boolean>;
  read(): Promise<NowPlayingReading | null>;
  send(command: 'play' | 'pause'): Promise<boolean>;
}

const MAC: NowPlayingSource = {
  platform: 'darwin',
  available: () => macAvailable(),
  read: () => macRead(),
  send: (command) => macSend(command),
};

const LINUX: NowPlayingSource = {
  platform: 'linux',
  available: () => mprisAvailable(),
  read: () => readMpris(),
  send: (command) => sendMpris(command),
};

/** Null on a platform with no implementation, which the adapter reports. */
export function sourceFor(platform: string = process.platform): NowPlayingSource | null {
  if (platform === 'darwin') return MAC;
  if (platform === 'linux') return LINUX;
  return null;
}

export const UNSUPPORTED =
  'no system Now Playing register here — this adapter supports macOS (MediaRemote) ' +
  'and Linux (MPRIS, via playerctl)';
