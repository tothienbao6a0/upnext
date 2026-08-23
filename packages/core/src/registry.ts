import { AQError, ErrorCodes, toSerializedError } from './errors.js';
import type { Adapter, AdapterEvent, SerializedError } from './types/index.js';

export interface RegistryHandlers {
  onEvent(adapter: Adapter, event: AdapterEvent): void;
  onError(adapterId: string, error: SerializedError): void;
}

/**
 * Owns adapter lifecycle: registration, subscription, teardown.
 *
 * Separated from the runtime because none of it has anything to do with queues
 * or playback — it is bookkeeping over a set of backends whose `init` may fail,
 * whose `subscribe` may not exist, and whose `dispose` must run exactly once.
 */
export class AdapterRegistry {
  #adapters = new Map<string, Adapter>();
  #unsubscribes = new Map<string, () => void>();
  #handlers: RegistryHandlers;

  constructor(handlers: RegistryHandlers) {
    this.#handlers = handlers;
  }

  add(adapter: Adapter): void {
    if (this.#adapters.has(adapter.id)) {
      throw new AQError(ErrorCodes.AdapterFailed, `adapter ${adapter.id} already registered`);
    }
    this.#adapters.set(adapter.id, adapter);

    if (adapter.subscribe) {
      this.#unsubscribes.set(
        adapter.id,
        adapter.subscribe((event) => this.#handlers.onEvent(adapter, event)),
      );
    }

    // A backend that cannot start up is reported, not thrown: the rest of the
    // queue should keep working when one source is unavailable.
    void adapter.init?.().catch((err: unknown) => {
      this.#handlers.onError(adapter.id, toSerializedError(err, adapter.id));
    });
  }

  async remove(id: string): Promise<Adapter | undefined> {
    const adapter = this.#adapters.get(id);
    if (!adapter) return undefined;
    this.#unsubscribes.get(id)?.();
    this.#unsubscribes.delete(id);
    this.#adapters.delete(id);
    await adapter.dispose?.();
    return adapter;
  }

  get(id: string): Adapter | undefined {
    return this.#adapters.get(id);
  }

  list(): Adapter[] {
    return [...this.#adapters.values()];
  }

  /** Stop a backend, reporting rather than throwing — used on transitions. */
  async stop(adapter: Adapter): Promise<void> {
    try {
      await adapter.stop();
    } catch (err) {
      // A backend that will not stop is not a reason to refuse to start.
      this.#handlers.onError(adapter.id, toSerializedError(err, adapter.id));
    }
  }

  async disposeAll(): Promise<void> {
    for (const [id, off] of this.#unsubscribes) {
      off();
      this.#unsubscribes.delete(id);
    }
    await Promise.allSettled(this.list().map((adapter) => adapter.dispose?.()));
    this.#adapters.clear();
  }
}
