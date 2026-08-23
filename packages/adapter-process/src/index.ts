import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { defaultCapabilities } from '@upnext/core';
import type {
  Adapter,
  AdapterEvent,
  AdapterState,
  Binding,
  Capabilities,
  MediaRef,
} from '@upnext/core';
import { isEvent, type Handshake, type Incoming, type Response } from './protocol.js';

export * from './protocol.js';

export interface ProcessAdapterOptions {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** How long to wait for any single reply before giving up. */
  requestTimeoutMs?: number;
  /** Where the child's stderr goes. Defaults to the parent's. */
  stderr?: 'inherit' | 'ignore';
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * An adapter that lives in another process, and possibly another language.
 *
 * From the runtime's side this is an ordinary `Adapter` — it has capabilities,
 * it resolves, it plays, it pushes events. The pipe is an implementation
 * detail. That is what lets someone contribute a backend without touching the
 * core, and without agreeing to write TypeScript.
 */
export class ProcessAdapter implements Adapter {
  readonly id: string;

  #options: ProcessAdapterOptions;
  #capabilities: Capabilities = { ...defaultCapabilities };
  #handshake: Handshake = { capabilities: {} };
  #child: ChildProcess | null = null;
  #reader: Interface | null = null;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: AdapterEvent) => void>();
  #nextRequestId = 1;
  #closed = false;
  #initPromise: Promise<void> | null = null;

  constructor(options: ProcessAdapterOptions) {
    this.id = options.id;
    this.#options = options;
  }

  get capabilities(): Capabilities {
    return this.#capabilities;
  }

  /**
   * Idempotent, and it has to be: `Runtime` calls `init` when an adapter is
   * registered, and a host that wants to await the handshake will call it too.
   * Spawning twice would leave an orphaned child holding the event loop open.
   */
  init(): Promise<void> {
    this.#initPromise ??= this.#spawnAndHandshake();
    return this.#initPromise;
  }

  async #spawnAndHandshake(): Promise<void> {
    const child = spawn(this.#options.command, this.#options.args ?? [], {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.env },
      stdio: ['pipe', 'pipe', this.#options.stderr ?? 'inherit'],
    });
    this.#child = child;
    this.#closed = false;

    this.#reader = createInterface({ input: child.stdout! });
    this.#reader.on('line', (line) => this.#onLine(line));

    child.on('exit', (code) => {
      this.#closed = true;
      const error = new Error(`${this.id}: adapter process exited with code ${code}`);
      for (const [, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      this.#emit({ type: 'error', code: 'process_exited', message: error.message });
    });

    const handshake = (await this.#request('init')) as Handshake;
    this.#handshake = handshake ?? { capabilities: {} };
    this.#capabilities = { ...defaultCapabilities, ...this.#handshake.capabilities };
  }

  /**
   * Evaluated locally from what the child declared, because the in-process
   * contract requires `match` to be synchronous and a pipe is not.
   */
  match(ref: MediaRef): number {
    const { schemes = [], schemeScore = 1, matchesTitles, titleScore = 0.3 } = this.#handshake;
    if (ref.uri) {
      return schemes.some((scheme) => ref.uri!.startsWith(scheme)) ? schemeScore : 0;
    }
    return matchesTitles && ref.title ? titleScore : 0;
  }

  async resolve(ref: MediaRef): Promise<Binding | null> {
    const result = (await this.#request('resolve', { ref })) as Binding | null;
    if (!result) return null;
    // The child does not get to claim to be a different adapter.
    return { ...result, adapterId: this.id };
  }

  async search(query: string, limit?: number): Promise<MediaRef[]> {
    return ((await this.#request('search', { query, limit })) as MediaRef[]) ?? [];
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

  async poll(): Promise<AdapterState> {
    return (await this.#request('poll')) as AdapterState;
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.#closed = true;
    this.#initPromise = null;
    for (const [, pending] of this.#pending) clearTimeout(pending.timer);
    this.#pending.clear();
    this.#reader?.close();
    this.#reader = null;
    this.#child?.kill('SIGKILL');
    this.#child = null;
    this.#listeners.clear();
  }

  #request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed || !this.#child?.stdin) {
      return Promise.reject(new Error(`${this.id}: adapter process is not running`));
    }
    const id = this.#nextRequestId++;
    const timeoutMs = this.#options.requestTimeoutMs ?? 10_000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${this.id}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // A pending request must never hold the event loop open on its own.
      timer.unref?.();

      this.#pending.set(id, { resolve, reject, timer });
      this.#child!.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: Incoming;
    try {
      message = JSON.parse(trimmed) as Incoming;
    } catch {
      // A child that writes junk to stdout is a bug in the child, not a reason
      // to tear down playback.
      this.#emit({
        type: 'error',
        code: 'bad_message',
        message: `${this.id}: unparseable line from adapter process`,
      });
      return;
    }

    if (isEvent(message)) {
      this.#emit(message.event);
      return;
    }

    const response = message as Response;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(new Error(`${this.id}: ${response.error.message}`));
    } else {
      pending.resolve(response.result ?? null);
    }
  }

  #emit(event: AdapterEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}
