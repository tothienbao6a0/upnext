/**
 * The protocol.
 *
 * Everything re-exported here is the contract that adapters, hosts and agents
 * agree on. It is deliberately transport-agnostic: the same shapes serialize to
 * JSON for an out-of-process adapter or for a daemon speaking to a harness in
 * another language.
 */
export type { MediaRef, Binding } from './media.js';
export type { Capabilities } from './capabilities.js';
export { defaultCapabilities } from './capabilities.js';
export type { ItemStatus, QueueItem, Position, SerializedError } from './queue.js';
export type { PlaybackStatus, PlaybackState } from './playback.js';
export { idlePlayback } from './playback.js';
export type { Adapter, AdapterEvent, AdapterState } from './adapter.js';
export type {
  IntentContext,
  IntentResolver,
  DesyncPolicy,
  RuntimeEvents,
} from './events.js';
