import { defaultCapabilities } from 'upnext-core';
import type {
  Adapter,
  AdapterState,
  Binding,
  Capabilities,
  MediaRef,
} from 'upnext-core';
import { isAvailable, readNowPlaying, sendTransport } from './mediaremote.js';
import { hasEnded, readingUri, type NowPlayingReading } from './reading.js';

/** The one thing this adapter can be asked for. */
export const NOW_PLAYING_URI = 'nowplaying:current';

export interface NowPlayingAdapterOptions {
  id?: string;
  /** Injected for tests, and for a host that has its own source of truth. */
  read?: () => Promise<NowPlayingReading | null>;
  send?: (command: 'play' | 'pause') => Promise<boolean>;
}

/**
 * Whatever the machine is already playing, as a queue entry.
 *
 * Every other adapter is handed a locator and told to play it. This one cannot
 * be: there is no way to ask macOS's Now Playing register to start a particular
 * track. What it *can* do is see what some other app is playing — a browser tab,
 * VLC, anything in Control Center — and work the transport.
 *
 * So it answers to exactly one entry, `nowplaying:current`, meaning *the thing
 * that is on*. That turns out to be worth having:
 *
 *   runtime.enqueue('nowplaying:current');   // let their podcast finish
 *   runtime.enqueue({ title: 'Bad Habit' }); // then take over
 *
 * which is an agent adding to someone's listening instead of interrupting it.
 *
 * It also sits at the far end of the capability spectrum — further than the
 * Spotify adapter, which at least starts the tracks it plays. Here the runtime
 * is a guest: the item was chosen by somebody else, in an app it does not
 * control, and it can be changed underneath at any moment. `externalControl`
 * has never meant more than it does here.
 */
export class NowPlayingAdapter implements Adapter {
  readonly id: string;

  readonly capabilities: Capabilities = {
    ...defaultCapabilities,
    // No notifications from the register; we sample it.
    endOfTrack: 'poll',
    // Elapsed time comes from the player itself, not from a clock of ours.
    position: 'authoritative',
    pause: true,
    // The register exposes no volume, and its seek command takes options the
    // JXA bridge cannot pass cleanly. Declaring either would be a lie.
    seek: false,
    volume: false,
    search: false,
    // The strongest case in the library: we did not even start this.
    externalControl: true,
  };

  #options: NowPlayingAdapterOptions;
  #binding: Binding | null = null;

  constructor(options: NowPlayingAdapterOptions = {}) {
    this.id = options.id ?? 'nowplaying';
    this.#options = options;
  }

  async init(): Promise<void> {
    if (this.#options.read) return; // Injected: nothing to probe.
    if (!(await isAvailable())) {
      throw new Error(
        'macOS Now Playing is unavailable here — this adapter needs macOS and the MediaRemote framework',
      );
    }
  }

  /**
   * Only ever `nowplaying:current`. This adapter cannot be handed a track.
   *
   * Scoring anything else above zero would be claiming it could start a file or
   * a Spotify URI, and it cannot start anything at all.
   */
  match(ref: MediaRef): number {
    return ref.uri === NOW_PLAYING_URI ? 1 : 0;
  }

  async resolve(ref: MediaRef): Promise<Binding | null> {
    if (this.match(ref) === 0) return null;

    const reading = await this.#read();
    // Nothing is playing, so there is nothing to adopt. Failing here is right:
    // the entry meant "the thing that is on" and there is no such thing.
    if (!reading) return null;

    return {
      adapterId: this.id,
      // The synthesised locator changes with the track, which is what lets the
      // runtime notice the person skipping in their browser.
      nativeUri: readingUri(reading),
      ref: {
        ...ref,
        title: reading.title,
        artist: reading.artist,
        durationMs: reading.durationMs,
        meta: { app: reading.label, bundleId: reading.bundleId },
      },
    };
  }

  /** Nothing to load. Something else already did. */
  async load(binding: Binding): Promise<void> {
    this.#binding = binding;
  }

  async play(): Promise<void> {
    await this.#send('play');
  }

  async pause(): Promise<void> {
    await this.#send('pause');
  }

  /**
   * Pause, never kill.
   *
   * The runtime moving on to its own next entry is not a reason to take
   * somebody's podcast away from them — and there is no "stop" in this register
   * anyway, only a transport.
   */
  async stop(): Promise<void> {
    await this.#send('pause');
    this.#binding = null;
  }

  async poll(): Promise<AdapterState> {
    const reading = await this.#read();

    if (!reading) {
      // The app went away, or stopped publishing. Whatever we were following is
      // over as far as anyone can tell from here.
      return { status: 'ended', nativeUri: null };
    }

    return {
      status: hasEnded(reading) ? 'ended' : reading.playing ? 'playing' : 'paused',
      positionMs: reading.elapsedMs,
      durationMs: reading.durationMs,
      nativeUri: readingUri(reading),
    };
  }

  #read(): Promise<NowPlayingReading | null> {
    return (this.#options.read ?? readNowPlaying)();
  }

  #send(command: 'play' | 'pause'): Promise<boolean> {
    return (this.#options.send ?? sendTransport)(command);
  }
}
