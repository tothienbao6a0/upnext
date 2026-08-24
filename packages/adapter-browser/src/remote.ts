import { defaultCapabilities } from 'upnext-core';
import type {
  Adapter,
  AdapterEvent,
  Binding,
  Capabilities,
  MediaRef,
} from 'upnext-core';
import { MediaElementAdapter, type MediaElementLike } from './element.js';
import { score } from './sources.js';

/**
 * Driving a media element that lives somewhere else.
 *
 * In an Electron app the queue runs in the main process and the only thing that
 * can hold an `<audio>` is a renderer. In a web app the element may sit inside
 * an iframe or a worker-owned document. Either way the adapter and the element
 * are separated by a boundary that only passes messages.
 *
 * The transport is deliberately not named. A host that has `ipcMain`/`ipcRenderer`
 * uses that; one with `postMessage` uses that; a test uses two functions and no
 * boundary at all. This library takes a `Channel` and asks no further questions,
 * the same way `upnext-adapter-process` takes a command and does not care what
 * language is on the other end.
 */
export interface Channel {
  send(message: unknown): void;
  /** Returns an unsubscribe function. */
  subscribe(listener: (message: unknown) => void): () => void;
}

interface Command {
  id: number;
  method: 'load' | 'play' | 'pause' | 'stop' | 'seek' | 'setVolume';
  params?: unknown;
}

interface Reply {
  id: number;
  error?: string;
}

interface Pushed {
  event: AdapterEvent;
}

/**
 * Both ends run the same capabilities, because both ends are the same adapter —
 * `serveMediaElement` drives a real `MediaElementAdapter`. There is no handshake
 * to negotiate: a media element is a media element wherever it is sitting.
 */
const REMOTE_CAPABILITIES: Capabilities = {
  ...defaultCapabilities,
  endOfTrack: 'event',
  position: 'authoritative',
  seek: true,
  pause: true,
  volume: true,
  search: false,
  externalControl: false,
};

export interface RemoteMediaAdapterOptions {
  id?: string;
  channel: Channel;
  /** How long to wait for the far side before giving up. */
  requestTimeoutMs?: number;
  extraExtensions?: string[];
}

/** The side that lives with the `Runtime`. */
export class RemoteMediaAdapter implements Adapter {
  readonly id: string;
  readonly capabilities = REMOTE_CAPABILITIES;

  #options: RemoteMediaAdapterOptions;
  #listeners = new Set<(event: AdapterEvent) => void>();
  #pending = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #unsubscribe: (() => void) | null = null;
  #nextId = 1;

  constructor(options: RemoteMediaAdapterOptions) {
    this.id = options.id ?? 'browser';
    this.#options = options;
  }

  async init(): Promise<void> {
    this.#unsubscribe ??= this.#options.channel.subscribe((message) => this.#receive(message));
  }

  /**
   * Evaluated locally, never over the wire. `match` is synchronous by contract
   * and asking across a boundary on every resolution would be absurd — and
   * unnecessary, since what a media element accepts is knowable from the URL.
   */
  match(ref: MediaRef): number {
    return score(ref, this.#options.extraExtensions);
  }

  async resolve(ref: MediaRef): Promise<Binding | null> {
    if (!ref.uri || this.match(ref) === 0) return null;
    return { adapterId: this.id, nativeUri: ref.uri, ref: { ...ref } };
  }

  async load(binding: Binding, opts?: { startAtMs?: number }): Promise<void> {
    await this.#request('load', { binding, ...opts });
  }
  async play(): Promise<void> {
    await this.#request('play');
  }
  async pause(): Promise<void> {
    await this.#request('pause');
  }
  async stop(): Promise<void> {
    await this.#request('stop');
  }
  async seek(positionMs: number): Promise<void> {
    await this.#request('seek', { positionMs });
  }
  async setVolume(volume: number): Promise<void> {
    await this.#request('setVolume', { volume });
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    for (const [, pending] of this.#pending) clearTimeout(pending.timer);
    this.#pending.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#listeners.clear();
  }

  #request(method: Command['method'], params?: unknown): Promise<void> {
    void this.init();
    const id = this.#nextId++;
    const timeoutMs = this.#options.requestTimeoutMs ?? 5000;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${this.id}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#options.channel.send({ id, method, params } satisfies Command);
    });
  }

  #receive(message: unknown): void {
    if (!message || typeof message !== 'object') return;

    if ('event' in message) {
      const { event } = message as Pushed;
      for (const listener of [...this.#listeners]) listener(event);
      return;
    }

    const reply = message as Reply;
    const pending = this.#pending.get(reply.id);
    if (!pending) return;
    this.#pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.error) pending.reject(new Error(`${this.id}: ${reply.error}`));
    else pending.resolve();
  }
}

/**
 * The side that lives with the element. Call it once, wherever the DOM is.
 *
 * It drives a real `MediaElementAdapter`, so the behaviour on the far side of
 * the boundary is not a reimplementation that can drift — it is the same class
 * the in-process case uses.
 */
export function serveMediaElement(
  element: MediaElementLike | (() => MediaElementLike),
  channel: Channel,
  options: { id?: string; extraExtensions?: string[] } = {},
): () => void {
  const adapter = new MediaElementAdapter({ element, ...options });
  const offEvents = adapter.subscribe((event) => channel.send({ event } satisfies Pushed));

  const offCommands = channel.subscribe((message) => {
    if (!message || typeof message !== 'object' || !('method' in message)) return;
    const command = message as Command;
    void run(adapter, command)
      .then(() => channel.send({ id: command.id } satisfies Reply))
      .catch((err: unknown) =>
        channel.send({
          id: command.id,
          error: err instanceof Error ? err.message : String(err),
        } satisfies Reply),
      );
  });

  return () => {
    offCommands();
    offEvents();
    void adapter.dispose();
  };
}

/**
 * Apply one command, checking what came across the boundary.
 *
 * These arrive as `unknown` from another process — a renderer that reloaded
 * mid-flight, a host wiring the channel to the wrong window, a future version
 * sending a field this one has never heard of. Validating here means a bad
 * message becomes an error reply the runtime can fail over from, rather than a
 * `TypeError` thrown inside somebody's renderer where nothing is listening.
 */
async function run(adapter: MediaElementAdapter, command: Command): Promise<void> {
  const params = (command.params ?? {}) as Record<string, unknown>;

  switch (command.method) {
    case 'load': {
      const binding = params.binding as Binding | undefined;
      if (!binding || typeof binding.nativeUri !== 'string') {
        throw new Error('load requires a binding with a nativeUri');
      }
      const startAtMs = typeof params.startAtMs === 'number' ? params.startAtMs : undefined;
      return adapter.load(binding, startAtMs === undefined ? undefined : { startAtMs });
    }
    case 'play':
      return adapter.play();
    case 'pause':
      return adapter.pause();
    case 'stop':
      return adapter.stop();
    case 'seek': {
      const positionMs = params.positionMs;
      if (typeof positionMs !== 'number' || !Number.isFinite(positionMs)) {
        throw new Error('seek requires a finite positionMs');
      }
      return adapter.seek(positionMs);
    }
    case 'setVolume': {
      const volume = params.volume;
      if (typeof volume !== 'number' || !Number.isFinite(volume)) {
        throw new Error('setVolume requires a finite volume');
      }
      return adapter.setVolume(volume);
    }
    default:
      throw new Error(`unknown method ${String(command.method)}`);
  }
}
