/**
 * What a piece of media *is*, independent of where it comes from.
 *
 * The central design decision of this library: a queue entry is not a Spotify
 * URI. It is a description that binds to a source as late as possible. That is
 * what lets an agent enqueue something before knowing which backend will play
 * it, and what lets the runtime fall back to another source when one dies.
 *
 * `uri` is a hint, not the identity. When a strong external id (`isrc`, `mbid`)
 * is present, any adapter can independently locate the same recording.
 */
export interface MediaRef {
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  /** Recording-level id. The best cross-source join key for music. */
  isrc?: string;
  /** MusicBrainz recording id. */
  mbid?: string;
  /** A direct locator if one is known: spotify:track:..., file:///..., https://... */
  uri?: string;
  artwork?: string;
  /** Adapter-specific extras. Never interpreted by the core. */
  meta?: Record<string, unknown>;
}

/** A MediaRef that has been bound to a specific adapter and native locator. */
export interface Binding {
  adapterId: string;
  /** The locator this adapter will actually play. */
  nativeUri: string;
  /** Metadata as the adapter knows it. Usually richer than the original ref. */
  ref: MediaRef;
}
