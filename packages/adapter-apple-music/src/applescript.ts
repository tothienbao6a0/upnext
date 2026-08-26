import { execFile } from 'node:child_process';

/**
 * Talking to the Music app through its AppleScript dictionary.
 *
 * Every script here is wrapped in `if application "Music" is running`. That is
 * the load-bearing line: a bare `tell application "Music"` *launches* it, and a
 * status poll that opens a music player on somebody's machine is not a status
 * poll. When it is not running, these answer `not-running` and the adapter
 * reports nothing rather than starting something.
 *
 * Fields come back separated by ASCII 31, the unit separator, because track
 * titles contain every printable delimiter anyone would otherwise reach for —
 * pipes, tabs, commas, semicolons. A record delimiter that can appear inside a
 * field is a parser that fails on somebody's favourite song.
 */

const UNIT = '';
const RECORD = '';
export const DELIMITERS = { UNIT, RECORD } as const;

const TIMEOUT_MS = 10_000;

/**
 * AppleScript string escaping.
 *
 * Everything interpolated below is either a search term a user typed or a
 * persistent ID that came back from the app. Both cross into a scripting
 * language, so both get escaped — a title containing a quote would otherwise
 * end the string early and the rest would be parsed as code.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Wrap a body so it only runs when Music is already open. */
function guarded(body: string): string {
  return `if application "Music" is running then
	tell application "Music"
${body}
	end tell
else
	return "not-running"
end if`;
}

/**
 * Read what the app is doing.
 *
 * The `theState` naming is not stylistic: `st` is a reserved token in Music's
 * dictionary and `set st to …` is a syntax error. Discovered the hard way.
 *
 * Every field read sits inside a `try`, because `current track` raises rather
 * than answering empty when nothing has been loaded since launch — and one
 * missing field should cost that field, not the whole reading.
 */
export const STATE_SCRIPT = guarded(`		set theState to (player state as text)
		set theName to ""
		set theArtist to ""
		set theDuration to 0
		set thePosition to 0
		set theId to ""
		try
			set theName to (name of current track)
			set theArtist to (artist of current track)
			set theDuration to (duration of current track)
			set theId to (persistent ID of current track)
			set thePosition to player position
		end try
		return theState & "${UNIT}" & theName & "${UNIT}" & theArtist & "${UNIT}" & theDuration & "${UNIT}" & thePosition & "${UNIT}" & theId`);

/**
 * Search the library.
 *
 * This is the reason this adapter exists rather than being a second copy of the
 * Spotify one. Spotify's dictionary can play a URI you hand it but cannot look
 * anything up, so on a Mac with no token and no indexed folder, nothing could
 * turn "Bad Habit" into something playable. Music's dictionary can — which
 * makes this the first source that resolves a bare title with no credentials at
 * all.
 *
 * It searches the *library*, not the catalogue: what comes back is what the
 * person actually has.
 */
export function searchScript(query: string, limit: number): string {
  return guarded(`		set out to ""
		set found to (search playlist "Library" for ${quote(query)})
		set counted to 0
		repeat with aTrack in found
			if counted ≥ ${Math.max(1, Math.floor(limit))} then exit repeat
			try
				set out to out & (name of aTrack) & "${UNIT}" & (artist of aTrack) & "${UNIT}" & (duration of aTrack) & "${UNIT}" & (persistent ID of aTrack) & "${RECORD}"
				set counted to counted + 1
			end try
		end repeat
		return out`);
}

/** Start a specific track, addressed by the id the app gave us. */
export function playScript(persistentId: string): string {
  return guarded(`		set theTrack to (first track of playlist "Library" whose persistent ID is ${quote(persistentId)})
		play theTrack
		return "ok"`);
}

export const RESUME_SCRIPT = guarded('		play\n		return "ok"');
export const PAUSE_SCRIPT = guarded('		pause\n		return "ok"');

export function seekScript(seconds: number): string {
  return guarded(`		set player position to ${Math.max(0, seconds)}
		return "ok"`);
}

/** Music's own volume is 0–100; the contract is 0–1. */
export function volumeScript(volume: number): string {
  const level = Math.round(Math.min(1, Math.max(0, volume)) * 100);
  return guarded(`		set sound volume to ${level}
		return "ok"`);
}

export type ScriptRunner = (script: string) => Promise<string>;

export const runAppleScript: ScriptRunner = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', script],
      { timeout: TIMEOUT_MS },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
    );
  });

/** Whether the Music app exists here at all, without launching it. */
export async function isInstalled(run: ScriptRunner = runAppleScript): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    // Resolves through LaunchServices. Asks the system where the app is; does
    // not ask the app anything, so nothing starts.
    const out = await run('id of application "Music"');
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
