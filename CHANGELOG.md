# Changelog

Versions apply to all published packages together: `upnext-core`,
`upnext-adapter-local`, `upnext-adapter-process`.

## 0.0.2

Documentation only — no code changes, no API changes.

- Rewrote every README around diagrams rather than prose: the queue-ownership
  inversion, the capability spectrum, the lifecycle of a queue entry, and the
  out-of-process wire protocol.
- Every code sample in every README is now typechecked against the published
  packages under `nodenext --strict`. Two were wrong; one used a `~` path that
  Node does not expand, so the example would have quietly found nothing.

## 0.0.1

First release.

- **`upnext-core`** — the runtime. Owns the queue; adapters are execution
  backends. Zero dependencies and no I/O, so it runs identically in Node, Bun,
  Deno, Electron, Tauri or a browser.
  - Entries are `MediaRef` descriptions that bind to a source as late as
    possible, with cross-source identity on ISRC/MusicBrainz and verification
    that a resolution is actually what was asked for.
  - Capability model covering the range from a backend you fully own to an
    external player a human can also touch, published inline on playback state.
  - Intents as queue entries, resolved by a host-supplied callback. The core
    never calls a model or holds a key.
  - Id-addressed, versioned queue mutation with optional optimistic
    concurrency.
  - Desync reconciliation when a human takes over an external player. The human
    wins by default.
  - Adapters validated at registration; backends that fail to start are
    excluded and reported; every call out of the library is bounded by a
    timeout.
- **`upnext-adapter-local`** — files and streams via `ffplay` or `afplay`, with
  capabilities discovered from whichever binary is installed.
- **`upnext-adapter-process`** — adapters as subprocesses over newline-delimited
  JSON, with a complete Python example covered by the test suite.
