import { execFile } from 'node:child_process';
import { SpotifyError, classifyText } from './errors.js';
import { parseSpotifyUri, toSpotifyUri } from './uri.js';

/**
 * Talking to the Spotify desktop app through its AppleScript dictionary.
 *
 * The script text and the parsing are separated on purpose, and both are
 * exported. AppleScript is a string until the moment it runs, so the part most
 * likely to break — a field order that drifts, a property spelled wrong — is
 * exactly the part a type checker cannot see. Keeping the parser pure means the
 * wire format has real tests on a machine with no Spotify, no macOS and no
 * network, which is where this package's CI runs.
 */

/** ASCII unit separator. Written as an escape because the character is
 * invisible in an editor, and chosen over a tab or a pipe because a track title
 * is free text — anything a person might plausibly type would split a title in
 * half. */
export const FIELD = '\u001F';

/** How long any one script may take. A beachballing player, or a first run
 * waiting on the macOS Automation consent prompt, must not hold a sample
 * forever and let the next one stack behind it. */
export const SCRIPT_TIMEOUT_MS = 5_000;

/** The one dependency on the outside world, injectable so every decision this
 * package makes is testable without a Mac, a Spotify account, or an app. */
export type Osascript = (script: string) => Promise<string>;

export function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', script],
      { timeout: SCRIPT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const text = String(stderr || error.message);
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(
            new SpotifyError('unavailable', 'osascript is not available on this system'),
          );
        }
        reject(new SpotifyError(classifyText(text), text.trim() || 'osascript failed'));
      },
    );
  });
}

/**
 * One reading of the desktop app.
 *
 * `running: false` is a first-class answer, not an error. Spotify not being
 * open is the ordinary state of most machines most of the time, and a backend
 * that treats it as a failure would fill a host's logs with news it cannot act
 * on.
 */
export interface Sample {
  running: boolean;
  status: 'playing' | 'paused' | 'idle';
  positionMs: number;
  durationMs: number | null;
  /** What Spotify says it is playing, as a `spotify:` URI. */
  nativeUri: string | null;
  /** 0..1, or null when the app would not say. */
  volume: number | null;
}

/**
 * Read the app's state without ever launching it.
 *
 * `if application "Spotify" is running` is the load-bearing line. A bare
 * `tell application "Spotify"` *launches* Spotify, so a sampler running every
 * second would boot a music player onto the machine of someone who never opened
 * one — and would do it on a poll the user never asked for. The guard is what
 * makes this safe to run on a timer.
 *
 * Every property sits behind its own `try` so that one that errors — and
 * `current track` errors whenever nothing is loaded — costs its own field
 * rather than the whole reading.
 */
export function stateScript(): string {
  return `on run
	set AppleScript's text item delimiters to (ASCII character 31)
	if application "Spotify" is running then
		tell application "Spotify"
			set stateField to "idle"
			set positionField to "0"
			set trackField to ""
			set durationField to ""
			set volumeField to ""
			try
				set stateField to (player state as text)
			end try
			try
				set positionField to (player position as text)
			end try
			try
				set trackField to (id of current track as text)
			end try
			try
				set durationField to (duration of current track as text)
			end try
			try
				set volumeField to (sound volume as text)
			end try
			return {"running", stateField, positionField, trackField, durationField, volumeField} as text
		end tell
	end if
	return ""
end run`;
}

/**
 * Turn a reading into a `Sample`, or `null` if the text is not one.
 *
 * Anything malformed answers null rather than a half-filled sample: a sample
 * with a NaN playhead would be read as a real position and could end a track
 * that is still playing, where a missing sample simply means this tick learned
 * nothing and the next one will.
 */
export function parseSample(raw: string): Sample | null {
  const trimmed = raw.trim();
  // Empty is the script's own word for "Spotify is not open" — a real answer.
  if (!trimmed) {
    return { running: false, status: 'idle', positionMs: 0, durationMs: null, nativeUri: null, volume: null };
  }

  const fields = trimmed.split(FIELD);
  if (fields[0] !== 'running' || fields.length < 6) return null;

  const parsed = parseSpotifyUri(fields[3]);
  const durationMs = positiveInt(fields[4]);
  const volume = positiveFloat(fields[5]);

  return {
    running: true,
    status: readStatus(fields[1]),
    // Spotify reports the playhead in seconds and the track length in
    // milliseconds. Everything above this line is milliseconds.
    positionMs: Math.round((positiveFloat(fields[2]) ?? 0) * 1000),
    durationMs,
    nativeUri: parsed ? toSpotifyUri(parsed) : null,
    volume: volume === null ? null : Math.min(1, Math.max(0, volume / 100)),
  };
}

/** Spotify's dictionary spells the three states exactly this way. */
function readStatus(value: string | undefined): Sample['status'] {
  if (value === 'playing') return 'playing';
  if (value === 'paused') return 'paused';
  return 'idle';
}

function positiveFloat(value: string | undefined): number | null {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function positiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// -- commands ---------------------------------------------------------------

/**
 * Start a specific track.
 *
 * This is the one script allowed to launch Spotify, because it only ever runs
 * as the direct result of something asking for playback. `activate` is
 * deliberately absent: starting a song should not take the foreground away from
 * whatever the person is actually looking at.
 *
 * A start offset needs the pause. `play track` returns as soon as the command
 * is accepted, not when the track is loaded, and moving the playhead of a track
 * that has not loaded yet either errors or is silently discarded — so the seek
 * is retried until it takes, which costs nothing in the common case where
 * `startAtMs` is zero and none of this runs.
 */
export function playTrackScript(nativeUri: string, startAtMs = 0): string {
  const seconds = Math.max(0, Math.round(startAtMs / 1000));
  const seek =
    seconds > 0
      ? `
		repeat 20 times
			try
				if player state is playing then
					set player position to ${seconds}
					exit repeat
				end if
			end try
			delay 0.1
		end repeat`
      : '';
  return `tell application "Spotify"
		play track ${quote(nativeUri)}${seek}
	end tell`;
}

/**
 * Any other verb, wrapped so it cannot launch the app.
 *
 * There is nothing to pause, seek or re-level in an app that is not open, and
 * launching one to tell it to be quiet would be absurd — so unlike
 * `playTrackScript`, everything here is behind the running guard.
 */
export function commandScript(body: string): string {
  return `if application "Spotify" is running then
	tell application "Spotify"
		${body}
	end tell
end if`;
}

export const commands = {
  play: 'play',
  /**
   * Spotify's dictionary has no stop that does not quit the app, and quitting
   * someone's music player because a queue moved to a different source would be
   * far ruder than leaving it paused. `stop` therefore means pause here, and
   * that is the honest description of what happens.
   */
  pause: 'pause',
  seek: (positionMs: number) => `set player position to ${Math.max(0, Math.round(positionMs / 1000))}`,
  volume: (volume: number) =>
    `set sound volume to ${Math.min(100, Math.max(0, Math.round(volume * 100)))}`,
} as const;

/**
 * A string literal AppleScript will read as one string.
 *
 * Only ever given a `spotify:` URI built by `toSpotifyUri` from a validated
 * base-62 id, so there is nothing here to escape in practice — but this text
 * becomes a program, and a quoting function that exists is cheaper than the
 * argument about whether the caller can always be trusted.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
