import { UpNextError, ErrorCodes, toSerializedError } from './errors.js';
import { similarity } from './identity.js';
import { describe } from './input.js';
import type {
  Adapter,
  Binding,
  IntentContext,
  IntentResolver,
  MediaRef,
  SerializedError,
} from './types/index.js';

export interface BinderDeps {
  adapters(): Adapter[];
  /**
   * Minimum confidence that what an adapter returned is what was asked for.
   * Guards against the classic cross-source failure of confidently playing the
   * wrong song.
   */
  matchThreshold: number;
  resolveIntent?: IntentResolver | undefined;
  /**
   * How long any single call out of the library may take before it is treated
   * as failed. `null` waits forever.
   */
  timeoutMs: number | null;
  onAdapterError(adapterId: string, error: SerializedError): void;
}

export interface BindOptions {
  /** Adapters already tried for this item; they will not be tried again. */
  attempted?: readonly string[];
  /** Also load and start playback on the winning adapter. */
  start?: boolean;
  /** Checked between awaits so a superseded bind abandons its work. */
  cancelled?: () => boolean;
}

export type BindOutcome =
  | { ok: true; adapter: Adapter; binding: Binding; attempted: string[] }
  | { ok: false; error: SerializedError; attempted: string[] }
  | { ok: false; cancelled: true; attempted: string[] };

/**
 * Turns a description of media into a backend that is playing it.
 *
 * Kept separate from the runtime because this is where the interesting policy
 * lives — which source to prefer, how sure we have to be that it is the right
 * recording, and what to do when the preferred source fails. None of that is
 * coupled to queues, timers or transport.
 */
export class Binder {
  constructor(private readonly deps: BinderDeps) {}

  /** How many backends exist at all, regardless of what they claim. */
  get adapterCount(): number {
    return this.deps.adapters().length;
  }

  /** Resolve natural language into something concrete. */
  async intent(text: string, ctx: IntentContext): Promise<MediaRef | null> {
    const resolve = this.deps.resolveIntent;
    if (resolve) {
      const result = await this.#guard(Promise.resolve(resolve(text, ctx)), 'intent resolver');
      if (Array.isArray(result)) return result[0] ?? null;
      return result ?? null;
    }
    // No host resolver: fall back to adapter search so the library is useful
    // with nothing but adapters wired up.
    const results = await this.search(text, 1);
    return results[0] ?? null;
  }

  /** Fan out across every adapter that can search. */
  async search(
    query: string,
    limit = 10,
    adapterId?: string,
  ): Promise<Array<MediaRef & { adapterId: string }>> {
    const targets = this.deps
      .adapters()
      .filter((a) => a.search && a.capabilities.search && (!adapterId || a.id === adapterId));

    const settled = await Promise.allSettled(
      targets.map(async (adapter) => {
        const results = await this.#guard(
          adapter.search!(query, limit),
          `${adapter.id} search`,
          adapter.id,
        );
        return results.map((ref) => ({ ...ref, adapterId: adapter.id }));
      }),
    );

    const out: Array<MediaRef & { adapterId: string }> = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') out.push(...result.value);
    }
    return out.slice(0, limit);
  }

  /**
   * Try adapters in order of confidence until one plays the thing.
   *
   * This is where source-late pays off: if Spotify resolves but fails to load,
   * the same MediaRef goes to the next adapter and the listener hears the song
   * anyway, from somewhere else.
   */
  async bind(ref: MediaRef, opts: BindOptions = {}): Promise<BindOutcome> {
    const attempted = new Set(opts.attempted ?? []);
    const cancelled = opts.cancelled ?? (() => false);
    const candidates = this.candidates(ref, attempted);

    if (candidates.length === 0) {
      return {
        ok: false,
        attempted: [...attempted],
        error: {
          code: ErrorCodes.NoAdapter,
          message: `no adapter can handle ${describe(ref)}`,
        },
      };
    }

    let lastError: SerializedError | null = null;

    for (const adapter of candidates) {
      attempted.add(adapter.id);
      /** Whether this backend has been handed the item and may now hold it. */
      let engaged = false;

      try {
        const binding = await this.#guard(adapter.resolve(ref), `${adapter.id} resolve`, adapter.id);
        if (cancelled()) return { ok: false, cancelled: true, attempted: [...attempted] };
        if (!binding) continue;

        // Trust but verify. An adapter returning *something* is not the same as
        // it returning the right thing.
        if (this.confidence(ref, binding.ref) < this.deps.matchThreshold) {
          lastError = {
            code: ErrorCodes.ResolveFailed,
            message: `${adapter.id} returned a poor match for ${describe(ref)}`,
            adapterId: adapter.id,
          };
          continue;
        }

        if (opts.start) {
          engaged = true;
          await this.#guard(adapter.load(binding), `${adapter.id} load`, adapter.id);
          if (cancelled()) return this.#abandon(adapter, attempted);
          await this.#guard(adapter.play(), `${adapter.id} play`, adapter.id);
          if (cancelled()) return this.#abandon(adapter, attempted);
        }

        return { ok: true, adapter, binding, attempted: [...attempted] };
      } catch (err) {
        lastError = toSerializedError(err, adapter.id);
        // A backend that got as far as `load` may be holding the item, or even
        // making noise, so it has to be told to let go before the next one is
        // handed the same thing.
        if (engaged) await this.#quieten(adapter);
        this.deps.onAdapterError(adapter.id, lastError);
      }
    }

    return {
      ok: false,
      attempted: [...attempted],
      error: lastError ?? {
        code: ErrorCodes.ResolveFailed,
        message: `nothing could play ${describe(ref)}`,
      },
    };
  }

  /**
   * The runtime changed its mind while this backend was starting.
   *
   * The generation counter keeps the runtime from *tracking* superseded work,
   * but a backend that reached `play` is already making sound and will happily
   * keep doing so alongside whatever started next. Stopping it is the other
   * half of cancellation.
   */
  async #abandon(adapter: Adapter, attempted: Set<string>): Promise<BindOutcome> {
    await this.#quieten(adapter);
    return { ok: false, cancelled: true, attempted: [...attempted] };
  }

  async #quieten(adapter: Adapter): Promise<void> {
    try {
      await adapter.stop();
    } catch (err) {
      this.deps.onAdapterError(adapter.id, toSerializedError(err, adapter.id));
    }
  }

  /**
   * Bound how long the library will wait on code it does not control.
   *
   * Every call here crosses out of the runtime — into an adapter talking to a
   * network service, or into a host resolver that may be waiting on a model. If
   * one of them never returns, the queue stops forever with no error and
   * nothing playing, which is the worst failure this library can have. A
   * timeout turns that into an ordinary failure the caller already knows how to
   * handle: try the next source.
   */
  #guard<T>(work: Promise<T>, what: string, adapterId?: string): Promise<T> {
    const ms = this.deps.timeoutMs;
    if (ms === null) return work;

    return new Promise<T>((resolve, reject) => {
      // Deliberately not unref'd. An unref'd timer cannot fire when it is the
      // only thing pending — which is precisely the situation it exists for,
      // since a backend that has gone quiet leaves nothing else on the loop.
      // The timer is cleared the moment the work settles, so it only holds the
      // process open while a call is genuinely outstanding.
      const timer = setTimeout(() => {
        reject(new UpNextError(ErrorCodes.Timeout, `${what} timed out after ${ms}ms`, adapterId));
      }, ms);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err as Error);
        },
      );
    });
  }

  /** Adapters that claim this ref, best first. */
  candidates(ref: MediaRef, exclude: ReadonlySet<string>): Adapter[] {
    return this.deps
      .adapters()
      .filter((adapter) => !exclude.has(adapter.id))
      .map((adapter) => ({ adapter, score: score(adapter, ref) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.adapter);
  }

  /**
   * How sure are we that what came back is what was asked for? A ref that was
   * only ever a bare locator has nothing to compare, so it passes by default.
   */
  confidence(asked: MediaRef, got: MediaRef): number {
    const askedHasMetadata = Boolean(asked.title || asked.isrc || asked.mbid);
    const gotHasMetadata = Boolean(got.title || got.isrc || got.mbid);
    if (!askedHasMetadata || !gotHasMetadata) return 1;
    if (asked.uri && got.uri && asked.uri === got.uri) return 1;
    return similarity(asked, got);
  }
}

/** `match` is adapter-authored, so treat a throw or a NaN as "cannot help". */
function score(adapter: Adapter, ref: MediaRef): number {
  try {
    const value = adapter.match(ref);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  } catch {
    return 0;
  }
}
