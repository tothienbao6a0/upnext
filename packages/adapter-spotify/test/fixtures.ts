import { FIELD, type Osascript } from '../src/applescript.js';

/** Let pending microtasks and promise chains settle. */
export function flush(times = 6): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i++) chain = chain.then(() => new Promise((r) => setImmediate(r)));
  return chain;
}

export interface FakeSpotifyState {
  running: boolean;
  status: 'playing' | 'paused' | 'idle';
  /** Seconds, the way the app reports it. */
  positionSeconds: number;
  /** Milliseconds, the way the app reports it. */
  durationMs: number;
  trackUri: string;
  volume: number;
}

/**
 * A stand-in for the Spotify desktop app.
 *
 * Answers the real scripts this package sends, in the real wire format — the
 * canned reading below was captured from a live copy of Spotify rather than
 * invented, so a change that breaks the field order breaks these tests too.
 */
export class FakeSpotify {
  installed = true;
  state: FakeSpotifyState = {
    running: true,
    status: 'paused',
    positionSeconds: 0,
    durationMs: 210_000,
    trackUri: '',
    volume: 70,
  };

  /** Every script that was run, so a test can assert what was asked for. */
  readonly scripts: string[] = [];
  /** Just the URIs that `play track` was called with, in order. */
  readonly played: string[] = [];

  readonly osascript: Osascript = async (script) => {
    this.scripts.push(script);

    if (script.includes('id of application')) {
      if (!this.installed) throw new Error('Can’t get application "Spotify". (-1728)');
      return 'com.spotify.client\n';
    }

    if (script.startsWith('on run')) return this.reading();

    if (script.includes('play track')) {
      const match = script.match(/play track "([^"]+)"/);
      if (match?.[1]) {
        this.played.push(match[1]);
        this.state.trackUri = match[1];
        this.state.status = 'playing';
        this.state.positionSeconds = 0;
      }
      return '';
    }

    if (/^\t\tplay$/m.test(script)) {
      this.state.status = 'playing';
      return '';
    }
    if (/^\t\tpause$/m.test(script)) {
      this.state.status = 'paused';
      return '';
    }
    const seek = script.match(/set player position to (\d+)/);
    if (seek?.[1]) {
      this.state.positionSeconds = Number(seek[1]);
      return '';
    }
    const volume = script.match(/set sound volume to (\d+)/);
    if (volume?.[1]) {
      this.state.volume = Number(volume[1]);
      return '';
    }
    return '';
  };

  /** The exact shape `stateScript()` produces. Empty means "not open". */
  reading(): string {
    if (!this.state.running) return '';
    return [
      'running',
      this.state.status,
      String(this.state.positionSeconds),
      this.state.trackUri,
      String(this.state.durationMs),
      String(this.state.volume),
    ].join(FIELD);
  }

  /** Put the playhead at the very end of the current track. */
  toEnd(): void {
    this.state.positionSeconds = this.state.durationMs / 1000;
  }

  /** Pretend the app rolled over, or a person picked something else. */
  switchTo(uri: string): void {
    this.state.trackUri = uri;
    this.state.positionSeconds = 0;
    this.state.status = 'playing';
  }
}

/**
 * A reading captured from a real, running copy of Spotify.
 *
 * Kept verbatim because the risky part of `applescript.ts` is a wire format
 * nothing type-checks: the field order, the units each field is in, and the
 * fact that `id of current track` hands back a full `spotify:` URI rather than
 * a bare id. All three are only true because the app says so, and this is the
 * evidence that it did.
 */
export const CAPTURED_READING = [
  'running',
  'paused',
  '276.0',
  'spotify:track:1OWBh1eVxUdA1Z6UA8r4nh',
  '276000',
  '76',
].join(FIELD);
