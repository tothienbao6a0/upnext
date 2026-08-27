import { execFile } from 'node:child_process';
import type { NowPlayingReading } from './reading.js';

/**
 * Linux's answer to the same question: what is this machine playing?
 *
 * MPRIS is a D-Bus interface that media players implement — browsers, VLC,
 * Spotify's Linux client, mpv with a plugin, most of them. `playerctl` is the
 * standard command-line client for it, and this shells out to that for the same
 * reason the macOS side shells out to `osascript`: the protocol is somebody
 * else's moving target, and a process boundary is where it should stay.
 *
 * The important difference from the macOS path, and the reason this could be
 * written safely at all: **the output shape is ours.** `playerctl` takes a
 * `--format` template, so rather than parsing whatever a tool decided to print
 * this asks for exactly the fields it wants, in exactly the order it wants
 * them. There is no guessing at somebody else's serialisation.
 */

const TIMEOUT_MS = 4000;

/**
 * ASCII 31. Track titles contain every printable delimiter worth using.
 *
 * Spelled as an expression rather than written literally: an invisible byte in
 * source survives a compiler but not always an editor, a copy, or a patch, and
 * a delimiter that silently becomes the empty string takes every field with it
 * -- silently, because every record then parses as one field and returns null,
 * which is indistinguishable from nothing playing.
 */
const UNIT = String.fromCharCode(31);

/**
 * One record, in a shape this file chose.
 *
 * `default(…, 0)` guards the two numeric fields: a stream has no length, and a
 * player that has not started has no position. Without it those come back empty
 * and the record still parses — but a zero says the same thing more plainly.
 */
export const FORMAT = [
  '{{playerName}}',
  '{{status}}',
  '{{title}}',
  '{{artist}}',
  '{{album}}',
  '{{default(position,0)}}',
  '{{default(mpris:length,0)}}',
].join(UNIT);

export type Runner = (args: string[]) => Promise<string>;

export const runPlayerctl: Runner = (args) =>
  new Promise((resolve, reject) => {
    execFile('playerctl', args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
    );
  });

/**
 * Parse one record.
 *
 * MPRIS reports position and length in **microseconds**, which is the detail
 * most likely to be got wrong and the one worth stating twice.
 */
export function parseMpris(raw: string): NowPlayingReading | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(UNIT);
  if (parts.length < 7) return null;

  const [player = '', status = '', title = '', artist = '', album = '', position = '', length = ''] =
    parts;

  // Same filter as the macOS side, for the same reason: something that made a
  // noise is not necessarily something with a transport worth showing.
  if (!title.trim()) return null;
  const durationMs = micros(length);
  if (durationMs <= 0) return null;

  return {
    bundleId: player.trim(),
    label: player.trim(),
    playing: status.trim().toLowerCase() === 'playing',
    title: title.trim(),
    artist: artist.trim(),
    ...(album.trim() ? { album: album.trim() } : {}),
    elapsedMs: Math.max(0, micros(position)),
    durationMs,
  };
}

export async function readMpris(run: Runner = runPlayerctl): Promise<NowPlayingReading | null> {
  try {
    return parseMpris(await run(['metadata', '--format', FORMAT]));
  } catch {
    // `playerctl` exits non-zero with "No players found" when nothing is
    // running, which is an ordinary state rather than a fault.
    return null;
  }
}

/**
 * playerctl's names for the transport commands, where they differ from ours.
 *
 * Only `play-pause` actually differs, but going through a map means a command
 * this file has not thought about cannot be passed through to the shell
 * unchecked.
 */
const PLAYERCTL: Record<MprisCommand, string> = {
  play: 'play',
  pause: 'pause',
  togglePlayPause: 'play-pause',
  next: 'next',
  previous: 'previous',
};

export type MprisCommand = 'play' | 'pause' | 'togglePlayPause' | 'next' | 'previous';

export async function sendMpris(
  command: MprisCommand,
  run: Runner = runPlayerctl,
): Promise<boolean> {
  const verb = PLAYERCTL[command];
  if (!verb) return false;
  try {
    await run([verb]);
    return true;
  } catch {
    return false;
  }
}

/** Whether `playerctl` is here at all. Nothing needs to be playing. */
export async function mprisAvailable(run: Runner = runPlayerctl): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    await run(['--version']);
    return true;
  } catch {
    return false;
  }
}

function micros(value: string): number {
  const n = Number.parseFloat(value);
  // Microseconds. Getting this wrong by a thousand is the classic MPRIS bug.
  return Number.isFinite(n) ? Math.round(n / 1000) : 0;
}
