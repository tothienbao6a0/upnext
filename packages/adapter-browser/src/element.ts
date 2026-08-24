import { defaultCapabilities } from 'upnext-core';
import type {
  Adapter,
  AdapterEvent,
  Binding,
  Capabilities,
  MediaRef,
} from 'upnext-core';
import { canPlay, describeSource, score } from './sources.js';

/**
 * The part of `HTMLMediaElement` this adapter actually uses.
 *
 * Deliberately tiny. A real `<audio>` satisfies it, so does a `<video>`, so
 * does a webview's element behind a proxy — and so does a fake in a test, which
 * is the point: none of this needs a browser to be exercised.
 */
export interface MediaElementLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  volume: number;
  readonly paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
  load?(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface MediaElementAdapterOptions {
  id?: string;
  /**
   * The element to drive. A function is allowed so the element can be created
   * lazily — browsers refuse to construct audio contexts before a user
   * gesture, and a host may not have a document yet when it builds its queue.
   */
  element: MediaElementLike | (() => MediaElementLike);
  /** Extra media types this element is known to handle, e.g. `['audio/flac']`. */
  extraExtensions?: string[];
}

/**
 * Plays audio through a media element you own.
 *
 * This sits at the fully-controlled end of the capability spectrum, and it is
 * the adapter that makes the core's claim true: `upnext-core` has always said
 * it runs anywhere JavaScript does, but until now the only thing that could
 * make a sound shelled out to `ffplay`, so a browser or an Electron renderer
 * had a queue and no way to play it.
 *
 * What it deliberately does **not** do is reach into pages the user already has
 * open. Commandeering somebody's YouTube tab needs a browser extension and is a
 * different feature with a different risk profile — this owns a player, which
 * is what a *queue* needs. See the README for where that line is.
 */
export class MediaElementAdapter implements Adapter {
  readonly id: string;

  readonly capabilities: Capabilities = {
    ...defaultCapabilities,
    // The element tells us. No polling, no duration timer, no guessing.
    endOfTrack: 'event',
    position: 'authoritative',
    seek: true,
    pause: true,
    volume: true,
    // Nothing to search — this plays a URL it is handed.
    search: false,
    // Nobody else has a handle on this element. If something else could pause
    // it, that would be the host's own UI, and the host already knows.
    externalControl: false,
  };

  #options: MediaElementAdapterOptions;
  #element: MediaElementLike | null = null;
  #listeners = new Set<(event: AdapterEvent) => void>();
  #detach: Array<() => void> = [];
  #binding: Binding | null = null;
  /** Set while we are tearing down, so our own `pause` is not reported. */
  #closing = false;

  constructor(options: MediaElementAdapterOptions) {
    this.id = options.id ?? 'browser';
    this.#options = options;
  }

  match(ref: MediaRef): number {
    return score(ref, this.#options.extraExtensions);
  }

  async resolve(ref: MediaRef): Promise<Binding | null> {
    if (!ref.uri || !canPlay(ref.uri, this.#options.extraExtensions)) return null;
    return {
      adapterId: this.id,
      nativeUri: ref.uri,
      ref: { ...ref, title: ref.title ?? describeSource(ref.uri) },
    };
  }

  async load(binding: Binding, opts?: { startAtMs?: number }): Promise<void> {
    const element = this.#ensure();
    this.#binding = binding;

    element.src = binding.nativeUri;
    element.load?.();
    if (opts?.startAtMs) element.currentTime = opts.startAtMs / 1000;
  }

  async play(): Promise<void> {
    const element = this.#ensure();
    // `play()` rejects when a browser blocks autoplay. That is a real failure
    // the runtime should hear about, not a warning to swallow — it falls
    // through to the next source, which may well be one that can make sound.
    await element.play();
  }

  async pause(): Promise<void> {
    this.#ensure().pause();
  }

  async stop(): Promise<void> {
    const element = this.#element;
    if (!element) return;
    this.#closing = true;
    try {
      element.pause();
      // Releases the network connection and stops buffering. Without it a long
      // podcast keeps downloading behind whatever plays next.
      element.src = '';
      element.load?.();
    } finally {
      this.#closing = false;
      this.#binding = null;
    }
  }

  async seek(positionMs: number): Promise<void> {
    this.#ensure().currentTime = Math.max(0, positionMs) / 1000;
  }

  async setVolume(volume: number): Promise<void> {
    this.#ensure().volume = Math.min(1, Math.max(0, volume));
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    // Wiring is deferred until someone is listening, so constructing an adapter
    // never touches the DOM — a host can build its queue before it has one.
    if (this.#listeners.size === 1) this.#wire();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#unwire();
    };
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.#unwire();
    this.#listeners.clear();
    this.#element = null;
  }

  // -- internals ------------------------------------------------------------

  #ensure(): MediaElementLike {
    if (!this.#element) {
      const source = this.#options.element;
      this.#element = typeof source === 'function' ? source() : source;
    }
    return this.#element;
  }

  #wire(): void {
    const element = this.#ensure();

    const on = (type: string, handler: () => void) => {
      element.addEventListener(type, handler);
      this.#detach.push(() => element.removeEventListener(type, handler));
    };

    on('ended', () => this.#emit({ type: 'ended' }));

    on('timeupdate', () => {
      const durationMs = toMs(element.duration);
      this.#emit({
        type: 'position',
        positionMs: Math.round(element.currentTime * 1000),
        ...(durationMs ? { durationMs } : {}),
      });
    });

    on('loadedmetadata', () => {
      const durationMs = toMs(element.duration);
      if (durationMs) {
        this.#emit({ type: 'position', positionMs: 0, durationMs });
      }
    });

    on('play', () => this.#emit({ type: 'status', status: 'playing' }));

    on('pause', () => {
      // Our own teardown pauses the element; reporting that would tell the
      // runtime the listener paused when in fact the track was being replaced.
      if (this.#closing) return;
      this.#emit({ type: 'status', status: 'paused' });
    });

    on('error', () => {
      this.#emit({
        type: 'error',
        code: 'media_error',
        message: `could not play ${this.#binding?.nativeUri ?? 'the loaded source'}`,
      });
    });
  }

  #unwire(): void {
    for (const off of this.#detach) off();
    this.#detach = [];
  }

  #emit(event: AdapterEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

/** A media element reports `NaN` before metadata and `Infinity` for streams. */
function toMs(seconds: number): number | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds * 1000);
}
