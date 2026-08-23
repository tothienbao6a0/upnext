/**
 * Minimal typed event emitter. Exists so core has zero dependencies.
 *
 * `Events` is intentionally unconstrained: an event map is naturally written as
 * an interface, and interfaces have no implicit index signature, so requiring
 * `Record<string, unknown>` would reject exactly the shape callers want to use.
 */
export class Emitter<Events> {
  #listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => {
      set!.delete(listener as (payload: never) => void);
    };
  }

  once<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    // Copy so a listener that unsubscribes mid-emit does not skip its neighbour.
    for (const listener of [...set]) {
      try {
        (listener as (p: Events[K]) => void)(payload);
      } catch {
        // A broken subscriber must never take down playback.
      }
    }
  }

  removeAll(): void {
    this.#listeners.clear();
  }
}
