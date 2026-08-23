/**
 * The public surface.
 *
 * Deliberately small. Everything here is something a host, an agent or an
 * adapter author needs; the collaborators the runtime is built from are not
 * exported, because a library whose value is a stable contract cannot afford to
 * have its internals depended on. They are available from `@aq/core/internal`
 * for anyone who accepts that they will move.
 */

// The protocol: what adapters, hosts and agents agree on.
export * from './types/index.js';

// The runtime.
export { Runtime } from './runtime.js';
export type { RuntimeSnapshot } from './runtime.js';
export type { RuntimeOptions } from './options.js';
export type { EnqueueInput } from './input.js';
export type { ReadonlyQueue } from './queue.js';

// Errors, as data and as exceptions.
export { AQError, ErrorCodes, toSerializedError } from './errors.js';

// Identity helpers, for adapter authors matching a ref against a catalogue.
export { identityKey, similarity, normalizeText, primaryArtist, isPlayable } from './identity.js';
export { describe as describeRef, looksLikeLocator } from './input.js';

// Time, so a host can test its own code deterministically.
export { ManualScheduler, systemScheduler, type Scheduler } from './scheduler.js';
