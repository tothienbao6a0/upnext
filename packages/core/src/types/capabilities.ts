/**
 * What a backend can and cannot do. Every adapter sits somewhere on the
 * spectrum from "I fully own this player" (a local file) to "an authoritative
 * external player that a human can also touch" (the Spotify desktop app).
 *
 * The core has to behave correctly across that whole spectrum, and an agent has
 * to be able to tell which end it is talking to. Booleans like `play: true` are
 * useless — every adapter can play. These are the flags that actually change
 * behaviour.
 */
export interface Capabilities {
  /**
   * How the runtime learns that a track finished.
   * - `event`: the adapter pushes. Accurate.
   * - `poll`: the runtime asks on an interval. Approximate.
   * - `none`: the runtime runs a duration timer. A guess.
   */
  endOfTrack: 'event' | 'poll' | 'none';

  /**
   * Where playback position comes from.
   * - `authoritative`: the backend reports real position.
   * - `estimated`: the runtime extrapolates from a local clock.
   * - `none`: unknown.
   */
  position: 'authoritative' | 'estimated' | 'none';

  /**
   * Can a human mutate this backend behind the runtime's back — by hitting next
   * in the Spotify app, say? If true the runtime must reconcile rather than
   * assume it is the only writer.
   */
  externalControl: boolean;

  seek: boolean;
  pause: boolean;
  volume: boolean;
  /** Can the adapter search its own catalogue? */
  search: boolean;
}

export const defaultCapabilities: Capabilities = {
  endOfTrack: 'none',
  position: 'none',
  externalControl: false,
  seek: false,
  pause: false,
  volume: false,
  search: false,
};
