import { execFile } from 'node:child_process';
import { parseReading, type NowPlayingReading } from './reading.js';

/**
 * macOS's own Now Playing register — how this reaches everything that isn't a
 * dedicated integration: a browser tab, VLC, Doppler, anything that shows up in
 * Control Center.
 *
 * This talks to `MediaRemote`, a private framework, through JXA's Objective-C
 * bridge. Private API is normally a bad trade, so the justification:
 *
 *   - There is no public equivalent. `MPNowPlayingInfoCenter` publishes *your
 *     own* app's state; nothing public reads another app's.
 *   - Apple began gating MediaRemote behind an entitlement in macOS 15.4, which
 *     broke the usual command-line tools. The gate applies to processes asking
 *     directly; script execution through `osascript` still resolves it, and
 *     that was verified on macOS 26.5.
 *   - The alternative is shipping a helper binary that borrows a system
 *     binary's entitlements — a far larger and more fragile dependency than a
 *     script you can read in full, here, above.
 *
 * Every failure answers null rather than throwing, so the day Apple closes this
 * the adapter reports itself unavailable and the rest of the queue carries on.
 */

const FRAMEWORK = '/System/Library/PrivateFrameworks/MediaRemote.framework/';
const SCRIPT_TIMEOUT_MS = 4000;

const READ_SCRIPT = `
ObjC.import('Foundation')
function run() {
  var bundle = $.NSBundle.bundleWithPath('${FRAMEWORK}')
  if (!bundle || !bundle.load) return ''
  var R = $.NSClassFromString('MRNowPlayingRequest')
  if (!R) return ''
  var path = R.localNowPlayingPlayerPath
  if (!path || path.isNil()) return ''
  var client = path.client
  if (!client || client.isNil()) return ''
  var item = R.localNowPlayingItem
  if (!item || item.isNil()) return ''
  var info = item.nowPlayingInfo
  if (!info || info.isNil()) return ''

  var str = function (v) { try { return v && !v.isNil() ? String(v.js) : '' } catch (e) { return '' } }
  var key = function (k) { try { var v = info.valueForKey(k); return v && !v.isNil() ? v.js : null } catch (e) { return null } }
  var num = function (k) { var v = key(k); var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : 0 }

  return JSON.stringify({
    bundleId: str(client.bundleIdentifier),
    label: str(client.displayName),
    playing: R.localIsPlaying === true,
    title: String(key('kMRMediaRemoteNowPlayingInfoTitle') || ''),
    artist: String(key('kMRMediaRemoteNowPlayingInfoArtist') || ''),
    album: String(key('kMRMediaRemoteNowPlayingInfoAlbum') || ''),
    elapsed: num('kMRMediaRemoteNowPlayingInfoElapsedTime'),
    duration: num('kMRMediaRemoteNowPlayingInfoDuration')
  })
}
`;

/**
 * MediaRemote's command numbers.
 *
 * Only the transport is here. The register exposes no volume, and its seek
 * command takes options this bridge cannot pass cleanly — which is exactly why
 * the adapter declares `seek: false` and `volume: false` rather than pretending.
 */
export const COMMANDS = {
  play: 0,
  pause: 1,
  togglePlayPause: 2,
  next: 4,
  previous: 5,
} as const;

export type TransportCommand = keyof typeof COMMANDS;

/**
 * The queue argument is load-bearing: passing nil there hangs the script
 * indefinitely, and a hung `osascript` would stall every poll behind it.
 */
const commandScript = (code: number) => `
ObjC.import('Foundation')
function run() {
  var bundle = $.NSBundle.bundleWithPath('${FRAMEWORK}')
  if (!bundle || !bundle.load) return ''
  var R = $.NSClassFromString('MRNowPlayingRequest')
  if (!R) return ''
  var path = R.localNowPlayingPlayerPath
  if (!path || path.isNil()) return ''
  var req = R.alloc.initWithPlayerPath(path)
  req.sendCommandOptionsQueueCompletion(
    ${code},
    $.NSDictionary.dictionary,
    $.NSOperationQueue.mainQueue.underlyingQueue,
    $()
  )
  return 'ok'
}
`;

function jxa(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      { timeout: SCRIPT_TIMEOUT_MS },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * What macOS is playing right now, whichever app is playing it.
 *
 * Exported on its own because it is useful without a queue: a host that only
 * wants to show what is on, or to know whether to duck, needs this and nothing
 * else. Answers null when nothing is playing, when the reading is not media, or
 * when the framework is unavailable.
 */
export async function readNowPlaying(): Promise<NowPlayingReading | null> {
  if (process.platform !== 'darwin') return null;
  try {
    return parseReading(await jxa(READ_SCRIPT));
  } catch {
    return null;
  }
}

/** Send a transport command to whatever the system considers now-playing. */
export async function sendTransport(command: TransportCommand): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    const out = await jxa(commandScript(COMMANDS[command]));
    return out.trim() === 'ok';
  } catch {
    return false;
  }
}

/** Whether this machine can answer at all. Used by the adapter's `init`. */
export async function isAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    // An empty answer still means the bridge resolved — nothing is playing,
    // which is a fine state. Only a thrown error means it cannot work here.
    await jxa(READ_SCRIPT);
    return true;
  } catch {
    return false;
  }
}
