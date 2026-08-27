import { defaultCapabilities } from './types/index.js';
import type {
  Adapter,
  AdapterEvent,
  AdapterReading,
  Binding,
  Capabilities,
  MediaRef,
  PlaybackStatus,
} from './types/index.js';

export interface FakeAdapterOptions {
  id?: string;
  capabilities?: Partial<Capabilities>;
  /** Catalogue this adapter can play. */
  catalogue?: MediaRef[];
  /** Return 0 from `match` for refs this predicate rejects. */
  handles?: (ref: MediaRef) => boolean;
  /** Throw on `load` — for exercising cross-source fallback. */
  failOnLoad?: boolean;
  /** Throw on `preload`, which the runtime must survive. */
  failOnPreload?: boolean;
  /** Return null from `resolve` — as if the catalogue lacks the track. */
  failOnResolve?: boolean;
  defaultDurationMs?: number;
}

/**
 * An in-memory backend for tests and for trying the runtime with nothing
 * installed. Its capabilities are fully configurable, which is the point: the
 * same runtime has to behave correctly whether a backend pushes events or has
 * to be polled, reports position or guesses at it, can be externally mutated
 * or cannot.
 */
export class FakeAdapter implements Adapter {
  readonly id: string;
  readonly capabilities: Capabilities;

  /** Every call the runtime made, in order. Assert against this. */
  readonly calls: string[] = [];

  #listeners = new Set<(event: AdapterEvent) => void>();
  #catalogue: MediaRef[];
  #opts: FakeAdapterOptions;
  #current: Binding | null = null;
  #status: PlaybackStatus = 'idle';
  #positionMs = 0;
  #nativeUri: string | null = null;

  constructor(options: FakeAdapterOptions = {}) {
    this.id = options.id ?? 'fake';
    this.capabilities = { ...defaultCapabilities, ...options.capabilities };
    this.#catalogue = options.catalogue ?? [];
    this.#opts = options;
  }

  match(ref: MediaRef): number {
    if (this.#opts.handles && !this.#opts.handles(ref)) return 0;
    if (ref.uri?.startsWith(`${this.id}:`)) return 1;
    return 0.5;
  }

  async resolve(ref: MediaRef): Promise<Binding | null> {
    this.calls.push('resolve');
    if (this.#opts.failOnResolve) return null;
    const hit = this.#catalogue.find(
      (entry) =>
        (ref.uri && entry.uri === ref.uri) ||
        (ref.isrc && entry.isrc === ref.isrc) ||
        (ref.title && entry.title?.toLowerCase() === ref.title.toLowerCase()),
    );
    const resolved: MediaRef = hit ?? {
      ...ref,
      durationMs: ref.durationMs ?? this.#opts.defaultDurationMs ?? 1000,
    };
    return {
      adapterId: this.id,
      nativeUri: resolved.uri ?? `${this.id}:${resolved.title ?? 'untitled'}`,
      ref: { ...resolved, durationMs: resolved.durationMs ?? this.#opts.defaultDurationMs ?? 1000 },
    };
  }

  async search(query: string, limit = 10): Promise<MediaRef[]> {
    this.calls.push('search');
    const needle = query.toLowerCase();
    return this.#catalogue
      .filter(
        (entry) =>
          entry.title?.toLowerCase().includes(needle) ||
          entry.artist?.toLowerCase().includes(needle),
      )
      .slice(0, limit);
  }

  /**
   * What the runtime offered ahead of time, in order.
   *
   * Here so a host can assert its own gapless behaviour: that the next item was
   * handed over while the current one was still playing, and that a queue
   * change re-offered the right thing.
   */
  readonly preloaded: string[] = [];

  async preload(binding: Binding): Promise<void> {
    this.calls.push('preload');
    if (this.#opts.failOnPreload) throw new Error(`${this.id} cannot prepare anything`);
    this.preloaded.push(binding.nativeUri);
  }

  async load(binding: Binding): Promise<void> {
    this.calls.push('load');
    if (this.#opts.failOnLoad) throw new Error(`${this.id} cannot load ${binding.nativeUri}`);
    this.#current = binding;
    this.#nativeUri = binding.nativeUri;
    this.#positionMs = 0;
    this.#status = 'loading';
  }

  async play(): Promise<void> {
    this.calls.push('play');
    this.#status = 'playing';
  }

  async pause(): Promise<void> {
    this.calls.push('pause');
    this.#status = 'paused';
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    this.#status = 'idle';
    this.#current = null;
    this.#nativeUri = null;
  }

  async seek(positionMs: number): Promise<void> {
    this.calls.push('seek');
    this.#positionMs = positionMs;
  }

  async setVolume(): Promise<void> {
    this.calls.push('volume');
  }

  async poll(): Promise<AdapterReading> {
    this.calls.push('poll');
    return {
      status: this.#status,
      positionMs: this.#positionMs,
      ...(this.#current?.ref.durationMs ? { durationMs: this.#current.ref.durationMs } : {}),
      nativeUri: this.#nativeUri,
    };
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // -- test controls --------------------------------------------------------

  emit(event: AdapterEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  /** Pretend the track finished. */
  finish(): void {
    this.#status = 'ended';
    this.emit({ type: 'ended' });
  }

  /** Pretend a human changed the track inside the native app. */
  takeover(nativeUri: string, ref?: MediaRef): void {
    this.#nativeUri = nativeUri;
    this.emit({ type: 'external', nativeUri, ...(ref ? { ref } : {}) });
  }

  /** Move the fake playhead, for poll-based tests. */
  setPosition(positionMs: number): void {
    this.#positionMs = positionMs;
  }

  get current(): Binding | null {
    return this.#current;
  }

  get status(): PlaybackStatus {
    return this.#status;
  }
}
