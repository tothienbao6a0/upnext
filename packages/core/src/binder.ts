import { ErrorCodes, toSerializedError } from './errors.js';
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

  /** Resolve natural language into something concrete. */
  async intent(text: string, ctx: IntentContext): Promise<MediaRef | null> {
    const resolve = this.deps.resolveIntent;
    if (resolve) {
      const result = await resolve(text, ctx);
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
      targets.map(async (adapter) =>
        (await adapter.search!(query, limit)).map((ref) => ({ ...ref, adapterId: adapter.id })),
      ),
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
      try {
        const binding = await adapter.resolve(ref);
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
          await adapter.load(binding);
          if (cancelled()) return { ok: false, cancelled: true, attempted: [...attempted] };
          await adapter.play();
          if (cancelled()) return { ok: false, cancelled: true, attempted: [...attempted] };
        }

        return { ok: true, adapter, binding, attempted: [...attempted] };
      } catch (err) {
        lastError = toSerializedError(err, adapter.id);
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
