import type { AdapterEvent, Capabilities } from '@upnext/core';

/**
 * The out-of-process form of the adapter contract.
 *
 * One JSON object per line, in both directions. That is the entire transport:
 * no framing headers, no schema registry, no code generation. A backend can be
 * sixty lines of Python and still be a first-class adapter, which matters
 * because the adapter ecosystem is the point of the library and most of the
 * people who can write a Spotify or Apple Music backend are not going to write
 * it in TypeScript.
 */

export interface Request {
  id: number;
  method: string;
  params?: unknown;
}

export interface Response {
  id: number;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface EventMessage {
  event: AdapterEvent;
}

export type Incoming = Response | EventMessage;

export function isEvent(message: Incoming): message is EventMessage {
  return 'event' in message && message.event !== undefined;
}

/**
 * What a child declares at startup.
 *
 * `match` has to be synchronous in the in-process contract — the runtime calls
 * it on every resolution — which is impossible across a pipe. So the child
 * declares its claims up front as data and the host evaluates them locally.
 */
export interface Handshake {
  capabilities: Partial<Capabilities>;
  /** URI schemes or prefixes this backend claims, e.g. ["spotify:", "https://open.spotify.com/"]. */
  schemes?: string[];
  /** Confidence for a claimed scheme. Defaults to 1. */
  schemeScore?: number;
  /** Whether the backend can attempt refs that have a title but no locator. */
  matchesTitles?: boolean;
  /** Confidence for a title-only ref. Defaults to 0.3. */
  titleScore?: number;
}
