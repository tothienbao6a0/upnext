import { isAvailable as macAvailable, readNowPlaying as macRead, sendTransport as macSend } from './mediaremote.js';
import type { TransportCommand } from './mediaremote.js';
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
  send(command: TransportCommand): Promise<boolean>;
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

/**
 * The package's public reads and commands, on whichever platform this is.
 *
 * These are what a host imports, and what the `upnext` CLI's `now`, `pause`
 * and `next` are built on. They dispatch rather than reaching for MediaRemote
 * directly — which they used to, quietly making the CLI macOS-only even after
 * the Linux register worked.
 */
export async function readNowPlaying(): Promise<NowPlayingReading | null> {
  const source = sourceFor();
  return source ? source.read() : null;
}

export async function sendTransport(command: TransportCommand): Promise<boolean> {
  const source = sourceFor();
  return source ? source.send(command) : false;
}

/** Whether this machine has a register we can reach at all. */
export async function isAvailable(): Promise<boolean> {
  const source = sourceFor();
  return source ? source.available() : false;
}
