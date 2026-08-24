# Changelog

Versions apply to all published packages together: `upnext-core`,
`upnext-adapter-local`, `upnext-adapter-spotify`, `upnext-adapter-process`.

## 0.1.0

**Breaking**, which is why this is a minor rather than a patch: `nativeQueue` is
gone from the published `Capabilities` type, so an adapter with a capability
literal will no longer compile. Every package moves together — an adapter built
against the new shape cannot be consumed alongside `upnext-core@0.0.2`.

### Added

- **`upnext-adapter-spotify`** — the first backend somebody else can also touch,
  and the first real exercise of the desync machinery. Two adapters, because
  they are genuinely not the same backend:
  - `SpotifyDesktopAdapter` drives the Spotify desktop app on macOS through its
    AppleScript dictionary. **No credentials, no account registration, nothing
    to install** beyond the app itself. Declares `search: false`, because the
    dictionary cannot search a catalogue and faking it would make every
    resolution of a title a coin flip dressed as a lookup.
  - `SpotifyWebAdapter` drives the Web API anywhere Node runs, and adds
    `search: true`. The host supplies `getAccessToken`; this library runs no
    OAuth flow and holds no client id, the same boundary the core draws around
    `resolveIntent`.
  - Both distinguish **our track ending and the backend rolling on** from **a
    person hitting next**, by remembering where the playhead was on the previous
    reading. Getting that backwards would mean a queue that silently defers to
    Spotify's autoplay after every song, or a listener whose choice is yanked
    away.
  - Reading state can never launch Spotify: a status poll that opens a music
    player on someone's machine is not a status poll. `stop()` pauses rather
    than quitting, because a queue moving to a podcast is not a reason to close
    somebody's app.
- Queue traversal: `setRepeat('off' | 'one' | 'all')` and `setShuffle`. Both are
  properties of the queue rather than of any backend, since no single backend
  can see the others. Repeat-one still yields to `next()`, and shuffle is a
  traversal order rather than a re-ordering of the caller's list.
- Persistence: `serialize()` and `restore()`. Restoring never starts playback,
  and drops every binding — a binding is a live handle to a backend session, so
  entries rebind against the adapters that exist now.

### Changed

- A disposed runtime now throws on `enqueue`, `move`, `remove` and `clear`
  instead of accepting a write to a queue nobody will ever hear.
- READMEs no longer imply a Spotify backend that did not exist. What ships today
  is stated at the top rather than at the bottom, and the positioning names the
  non-agent uses instead of addressing agent harnesses alone.

### Removed

- **`Capabilities.nativeQueue`.** It was declared, defaulted, and read by
  nothing — not even the validator — while adapter authors would have set it
  truthfully expecting something to happen. A decorative flag in a contract
  whose whole claim is that capabilities are honest is worse than a missing one.
  It returns in a minor version if gapless handoff does.

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
