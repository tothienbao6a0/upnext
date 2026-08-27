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

  /**
   * Can the backend get the *next* item ready while the current one plays?
   *
   * This is what closes the gap between tracks. Without it the runtime has to
   * wait for one thing to end before it can even start loading the next, and
   * that round trip is audible — a beat of silence at every transition.
   *
   * Deliberately narrower than the `nativeQueue` flag this replaces. That one
   * claimed a backend "holds a list", which is neither necessary nor sufficient:
   * what actually matters is whether it can be handed one thing early. A media
   * element with a spare buffer can; a backend with its own queue that we
   * cannot write to cannot.
   */
  preload: boolean;

  seek: boolean;
  pause: boolean;
  volume: boolean;
  /** Can the adapter search its own catalogue? */
  search: boolean;
}

export const defaultCapabilities: Capabilities = {
  preload: false,
  endOfTrack: 'none',
  position: 'none',
  externalControl: false,
  seek: false,
  pause: false,
  volume: false,
  search: false,
};
