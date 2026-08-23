import { Binder } from './binder.js';
import { Deck } from './deck.js';
import { Emitter } from './emitter.js';
import { AQError, ErrorCodes } from './errors.js';
import { createIdFactory } from './ids.js';
import { isPlayable } from './identity.js';
import { createItem, type EnqueueInput } from './input.js';
import { resolveOptions, type ResolvedOptions, type RuntimeOptions } from './options.js';
import { Prefetcher } from './prefetcher.js';
import { Queue } from './queue.js';
import { AdapterRegistry } from './registry.js';
import { planReconciliation } from './reconciler.js';
import type {
  Adapter,
  AdapterEvent,
  Binding,
  Capabilities,
  IntentContext,
  MediaRef,
  PlaybackState,
  PlaybackStatus,
  Position,
  QueueItem,
  RuntimeEvents,
  SerializedError,
} from './types/index.js';

export type { EnqueueInput } from './input.js';
export type { RuntimeOptions } from './options.js';

/** Statuses an entry never leaves, so it must not be ended or reported twice. */
const TERMINAL = new Set<QueueItem['status']>(['ended', 'skipped', 'failed']);

export interface RuntimeSnapshot {
  version: number;
  playback: PlaybackState;
  nowPlaying: QueueItem | null;
  queue: QueueItem[];
  adapters: Array<{ id: string; capabilities: Capabilities }>;
}

/**
 * The runtime owns the queue; adapters are execution backends.
 *
 * That inversion is the whole point. Spotify's queue, Apple Music's Up Next and
 * a browser tab's single media element are all just places to send one item at
 * a time. Ordering, intent and history live here, so an agent can put a Spotify
 * track, a YouTube video and a local recording in a row without knowing that
 * any of those things exist.
 *
 * This class is deliberately thin. Resolution lives in `Binder`, timing in
 * `Watcher`, the loaded item and its transport in `Deck`, lookahead in
 * `Prefetcher`, adapter lifecycle in `AdapterRegistry`, desync policy in
 * `reconciler`. What is left is orchestration and the surface an agent talks to.
 */
export class Runtime {
  readonly queue = new Queue();

  #emitter = new Emitter<RuntimeEvents>();
  #nextId = createIdFactory('q');
  #opts: ResolvedOptions;
  #registry: AdapterRegistry;
  #deck: Deck;
  #binder: Binder;
  #prefetcher: Prefetcher;

  /**
   * Bumped on every transition. Async work started under an old generation
   * discards its result — this is what makes "skip twice while a load is in
   * flight" behave instead of racing two tracks onto the speakers.
   */
  #generation = 0;
  /** The last entry that actually reached playback, for intent context. */
  #lastStartedId: string | null = null;
  #disposed = false;

  constructor(options: RuntimeOptions = {}) {
    this.#opts = resolveOptions(options);

    this.#registry = new AdapterRegistry({
      onEvent: (adapter, event) => this.#onAdapterEvent(adapter, event),
      onError: (adapterId, error) => this.#emitter.emit('adapter:error', { adapterId, error }),
    });

    this.#deck = new Deck(
      {
        onEnded: () => this.#onEnded(),
        onExternal: (nativeUri, ref) => this.#reconcile(nativeUri, ref),
        onError: (error) =>
          this.#emitter.emit('adapter:error', {
            adapterId: error.adapterId ?? 'unknown',
            error,
          }),
        onPlaybackChanged: (state) => this.#emitter.emit('playback:changed', state),
        onPosition: (itemId, positionMs, durationMs) =>
          this.#emitter.emit('position', { itemId, positionMs, durationMs }),
      },
      {
        scheduler: this.#opts.scheduler,
        pollIntervalMs: this.#opts.pollIntervalMs,
        positionIntervalMs: this.#opts.positionIntervalMs,
      },
    );

    this.#binder = new Binder({
      adapters: () => this.#registry.list(),
      matchThreshold: this.#opts.matchThreshold,
      resolveIntent: this.#opts.resolveIntent,
      onAdapterError: (adapterId, error) =>
        this.#emitter.emit('adapter:error', { adapterId, error }),
    });

    this.#prefetcher = new Prefetcher({
      queue: this.queue,
      binder: this.#binder,
      lookahead: this.#opts.lookahead,
      intentContext: (item) => this.#intentContext(item),
      onResolved: (item) => this.#emitter.emit('item:resolved', { item }),
      onChanged: () => this.#emitQueue(),
    });

    for (const adapter of options.adapters ?? []) this.addAdapter(adapter);
  }

  // -- events ---------------------------------------------------------------

  on<K extends keyof RuntimeEvents>(
    event: K,
    listener: (payload: RuntimeEvents[K]) => void,
  ): () => void {
    return this.#emitter.on(event, listener);
  }

  once<K extends keyof RuntimeEvents>(
    event: K,
    listener: (payload: RuntimeEvents[K]) => void,
  ): () => void {
    return this.#emitter.once(event, listener);
  }

  // -- adapters -------------------------------------------------------------

  addAdapter(adapter: Adapter): void {
    this.#registry.add(adapter);
  }

  async removeAdapter(id: string): Promise<void> {
    if (this.#deck.adapter?.id === id) await this.stop();
    await this.#registry.remove(id);
  }

  get adapters(): Adapter[] {
    return this.#registry.list();
  }

  // -- reading state --------------------------------------------------------

  getState(): RuntimeSnapshot {
    return {
      version: this.queue.version,
      playback: this.#deck.state,
      nowPlaying: this.nowPlaying(),
      queue: this.queue.list(),
      adapters: this.adapters.map((a) => ({ id: a.id, capabilities: a.capabilities })),
    };
  }

  getQueue(): QueueItem[] {
    return this.queue.list();
  }

  getPlayback(): PlaybackState {
    return this.#deck.state;
  }

  nowPlaying(): QueueItem | null {
    const id = this.#deck.itemId;
    return id ? (this.queue.get(id) ?? null) : null;
  }

  // -- queue mutation -------------------------------------------------------

  enqueue(input: EnqueueInput, position: Position = {}): QueueItem {
    const inserted = this.queue.insert(this.#newItem(input), position);
    this.#emitQueue();
    this.#prefetcher.pump();
    return inserted;
  }

  enqueueMany(inputs: EnqueueInput[], position: Position = {}): QueueItem[] {
    const out: QueueItem[] = [];
    let anchor = position;
    for (const input of inputs) {
      const item = this.queue.insert(this.#newItem(input), anchor);
      out.push(item);
      anchor = { after: item.id };
    }
    this.#emitQueue();
    this.#prefetcher.pump();
    return out;
  }

  move(id: string, position: Position, expectVersion?: number): void {
    this.#checkVersion(expectVersion);
    this.queue.move(id, position);
    this.#emitQueue();
    this.#prefetcher.pump();
  }

  remove(id: string, expectVersion?: number): void {
    this.#checkVersion(expectVersion);
    const wasActive = this.#deck.itemId === id;
    this.#prefetcher.cancel(id);
    this.queue.remove(id);
    this.#emitQueue();
    if (wasActive) void this.next();
    else this.#prefetcher.pump();
  }

  clear(opts: { keepActive?: boolean } = {}): void {
    this.queue.clear(opts);
    this.#emitQueue();
  }

  // -- transport ------------------------------------------------------------

  /** Play a specific entry, or resume/start the queue if no id is given. */
  async play(id?: string): Promise<void> {
    if (id) return this.#start(this.queue.require(id));
    if (this.#deck.status === 'paused') return this.#deck.resume();
    if (this.#deck.loaded) return;
    const next = this.queue.nextPlayable(null);
    if (next) await this.#start(next);
  }

  /** Enqueue and immediately play, without disturbing the rest of the queue. */
  async playNow(input: EnqueueInput): Promise<QueueItem> {
    const item = this.enqueue(input, { next: true });
    await this.#start(this.queue.require(item.id));
    return this.queue.require(item.id);
  }

  pause(): Promise<void> {
    return this.#deck.pause();
  }

  resume(): Promise<void> {
    return this.#deck.resume();
  }

  async toggle(): Promise<void> {
    if (this.#deck.status === 'playing') return this.pause();
    if (this.#deck.status === 'paused') return this.resume();
    return this.play();
  }

  async next(): Promise<void> {
    await this.#advance('skipped');
  }

  async previous(): Promise<void> {
    const prev = this.queue.previousPlayable(this.#deck.itemId);
    if (!prev) return;
    this.queue.update(prev.id, { status: 'ready', error: undefined });
    await this.#start(this.queue.require(prev.id));
  }

  seek(positionMs: number): Promise<void> {
    return this.#deck.loaded ? this.#deck.seek(positionMs) : Promise.resolve();
  }

  setVolume(volume: number): Promise<void> {
    return this.#deck.setVolume(volume);
  }

  async stop(): Promise<void> {
    await this.#halt('idle');
  }

  /** Fan out across every adapter that can search. Best matches first. */
  search(
    query: string,
    opts: { limit?: number; adapterId?: string } = {},
  ): Promise<Array<MediaRef & { adapterId: string }>> {
    return this.#binder.search(query, opts.limit ?? 10, opts.adapterId);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.stop();
    await this.#registry.disposeAll();
    this.#emitter.removeAll();
  }

  // -- starting and advancing ----------------------------------------------

  async #start(item: QueueItem): Promise<void> {
    if (this.#disposed) return;
    const generation = ++this.#generation;
    const cancelled = () => generation !== this.#generation;

    const previous = this.#deck.detach();
    if (previous) {
      this.#endPrevious(item.id);
      await this.#registry.stop(previous);
      if (cancelled()) return;
    }

    this.#deck.patch({ status: 'loading', itemId: item.id, positionMs: 0, durationMs: null });

    // A deliberate start is a fresh attempt: whatever failed last time — during
    // prefetch, or on a previous play of this same entry — gets another chance.
    // Without this, replaying an entry finds every adapter already excluded.
    if (this.queue.get(item.id)) {
      this.queue.update(item.id, { attempted: [], error: undefined });
    }

    const ref = await this.#refFor(item, cancelled);
    if (cancelled()) return;
    if (!ref) return this.#afterFailure(generation);

    const outcome = await this.#binder.bind(ref, { start: true, cancelled });
    if (cancelled()) return;

    this.queue.update(item.id, { attempted: outcome.attempted });
    if (!outcome.ok) {
      if (!('cancelled' in outcome)) this.#fail(item.id, outcome.error);
      return this.#afterFailure(generation);
    }

    this.#activate(item.id, outcome.adapter, outcome.binding);
  }

  /** Resolve an intent into a playable ref, failing the entry if it cannot. */
  async #refFor(item: QueueItem, cancelled: () => boolean): Promise<MediaRef | null> {
    if (!item.intent || isPlayable(item.ref)) return item.ref;

    const ref = await this.#binder.intent(item.intent, this.#intentContext(item));
    if (cancelled()) return null;
    if (!ref) {
      this.#fail(item.id, {
        code: this.#opts.resolveIntent
          ? ErrorCodes.IntentUnresolved
          : ErrorCodes.NoIntentResolver,
        message: this.#opts.resolveIntent
          ? `could not resolve intent: ${item.intent}`
          : 'no intent resolver, and no adapter could search',
      });
      return null;
    }
    this.queue.update(item.id, { ref, status: 'unresolved' });
    this.#emitter.emit('item:resolved', { item: this.queue.require(item.id) });
    return ref;
  }

  #activate(itemId: string, adapter: Adapter, binding: Binding): void {
    const existing = this.queue.require(itemId);
    this.queue.cursorId = itemId;
    this.queue.update(itemId, {
      status: 'active',
      binding,
      ref: { ...existing.ref, ...binding.ref },
      error: undefined,
    });

    this.#deck.attach(itemId, adapter, binding);
    this.#lastStartedId = itemId;

    this.#emitQueue();
    this.#emitter.emit('item:started', { item: this.queue.require(itemId) });
    this.#prefetcher.pump();
  }

  async #advance(reason: 'completed' | 'skipped'): Promise<void> {
    const fromId = this.#deck.itemId ?? this.queue.cursorId;

    if (fromId && this.queue.get(fromId)) {
      this.queue.update(fromId, { status: reason === 'completed' ? 'ended' : 'skipped' });
      this.#emitQueue();
      this.#emitter.emit('item:ended', { item: this.queue.require(fromId), reason });
    }

    const next = this.queue.nextPlayable(fromId);
    if (!next) return this.#halt('ended');
    await this.#start(next);
  }

  /** A dead entry must never stall the queue. Move on. */
  async #afterFailure(generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    this.#deck.patch({ status: 'idle', itemId: null, adapterId: null });
    if (!this.#opts.autoAdvance) return;
    const next = this.queue.nextPlayable(this.queue.cursorId);
    if (next) await this.#start(next);
  }

  /**
   * Tear everything down and land on a single final status.
   *
   * One transition, one event: stopping and then separately announcing `ended`
   * would flash a spurious `idle` through every subscriber, and a host watching
   * for "the queue is finished" would see the wrong thing first.
   */
  async #halt(status: PlaybackStatus): Promise<void> {
    this.#generation++;
    const adapter = this.#deck.detach();
    if (adapter) await this.#registry.stop(adapter);
    this.#deck.reset(status);
  }

  // -- backend feedback -----------------------------------------------------

  #onEnded(): void {
    if (!this.#opts.autoAdvance) return void this.#halt('ended');
    void this.#advance('completed');
  }

  #onAdapterEvent(adapter: Adapter, event: AdapterEvent): void {
    if (this.#deck.handleEvent(adapter, event)) return;
    // Events from a backend we are not currently using are noise, except for
    // errors, which a host may still want to surface.
    if (event.type === 'error') {
      this.#emitter.emit('adapter:error', {
        adapterId: adapter.id,
        error: { code: event.code, message: event.message, adapterId: adapter.id },
      });
    }
  }

  #reconcile(actualUri: string | null, ref?: MediaRef): void {
    const current = this.#deck.binding;
    const adapter = this.#deck.adapter;
    if (!current || !adapter) return;

    const plan = planReconciliation(this.#opts.desyncPolicy, current, actualUri, ref);
    if (plan.action === 'none') return;

    this.#emitter.emit('desync', {
      expected: current.nativeUri,
      actual: actualUri,
      action: plan.action,
    });

    if (plan.restore) return this.#restore(adapter, plan.restore);
    if (plan.adopt) this.#adopt(adapter, plan.adopt);
  }

  /** Force a backend back to what the runtime wanted. */
  #restore(adapter: Adapter, binding: Binding): void {
    void adapter
      .load(binding)
      .then(() => adapter.play())
      .catch((err: unknown) =>
        this.#emitter.emit('adapter:error', {
          adapterId: adapter.id,
          error: { code: ErrorCodes.LoadFailed, message: String(err), adapterId: adapter.id },
        }),
      );
  }

  /** Record what the human chose as a real entry, in place, and keep going. */
  #adopt(adapter: Adapter, binding: Binding): void {
    const previousId = this.#deck.itemId;
    this.#deck.detach();
    if (previousId) this.#endPrevious(null, previousId);

    const adopted = this.queue.insert(
      {
        id: this.#nextId(),
        status: 'ready',
        ref: binding.ref,
        addedAt: this.#opts.scheduler.now(),
      },
      previousId ? { after: previousId } : {},
    );
    this.#activate(adopted.id, adapter, binding);
  }

  // -- small internals ------------------------------------------------------

  #newItem(input: EnqueueInput): QueueItem {
    return createItem(input, this.#nextId(), this.#opts.scheduler.now());
  }

  /**
   * Context for resolving an intent.
   *
   * `nowPlaying` is never the entry being resolved. Once the runtime starts
   * loading an intent entry, the deck already points at it — but an agent
   * answering "something calmer than this" needs *this*, meaning the track the
   * listener actually just heard, so fall back to the last entry that played.
   */
  #intentContext(item: QueueItem): IntentContext {
    const current = this.nowPlaying();
    const contextId = current && current.id !== item.id ? current.id : this.#lastStartedId;
    const nowPlaying =
      contextId && contextId !== item.id ? (this.queue.get(contextId) ?? null) : null;
    return { item, nowPlaying, queue: this.queue.list() };
  }

  /**
   * Close out the outgoing entry when something else takes over.
   *
   * Entries that already reached a terminal status are left alone: `#advance`
   * has usually just ended them itself, and announcing the same entry twice
   * would make a listening host think two tracks finished.
   */
  #endPrevious(nextItemId: string | null, explicitId?: string): void {
    const id = explicitId ?? this.#deck.itemId;
    if (!id || id === nextItemId) return;
    const item = this.queue.get(id);
    if (!item || TERMINAL.has(item.status)) return;
    this.queue.update(id, { status: 'ended' });
    this.#emitter.emit('item:ended', { item: this.queue.require(id), reason: 'replaced' });
  }

  #fail(itemId: string, error: SerializedError): void {
    if (!this.queue.get(itemId)) return;
    this.queue.update(itemId, { status: 'failed', error });
    this.#emitQueue();
    this.#emitter.emit('item:failed', { item: this.queue.require(itemId), error });
  }

  #checkVersion(expected?: number): void {
    if (expected !== undefined && expected !== this.queue.version) {
      throw new AQError(
        ErrorCodes.VersionConflict,
        `queue is at version ${this.queue.version}, caller expected ${expected}`,
      );
    }
  }

  #emitQueue(): void {
    this.#emitter.emit('queue:changed', {
      version: this.queue.version,
      queue: this.queue.list(),
    });
  }
}
