# Changelog

Versions apply to all published packages together, so an adapter built against
one core version is never paired with another.

## 0.3.1

### Fixed

- **The MCP server introduced itself as `0.1.0`.** A hardcoded string, wrong
  since 0.2.0, in the one field every MCP client displays beside the server
  name. It reads its own `package.json` now.

  Nothing caught it because every test called `createServer` and then asked the
  object questions; none of them ever completed a handshake with it. There is
  now a test that connects over a linked transport pair and asserts what a
  client is actually told on `initialize` and `tools/list`.

### Added

- **`upnext --version`** (also `-v`), read from `package.json` rather than
  written down. The CLI had no way to say which version it was.

- **`server.json`**, so `upnext-mcp` can be listed in the official MCP
  registry, and `mcpName` in the package — the registry verifies ownership by
  reading that field out of the published npm tarball and requiring it to match
  the manifest. Both are checked against each other by a test, because the
  registry only reports a mismatch at publish time, by which point the npm
  release is already permanent.

## 0.3.0

Nothing breaking. On macOS every one of these is a no-op.

### Added

- **Now Playing on Linux.** `upnext-adapter-nowplaying` now reads and controls
  whatever the machine is playing on Linux as well as macOS, through MPRIS via
  `playerctl`. Same `nowplaying:current` entry, same reading, same adapter — a
  host does not have to know which OS it is on, and `sourceFor()` picks the
  register at `init()`.

  What made this safe to write, having previously been refused: `playerctl`
  takes a `--format` template, so the record shape is ours rather than
  somebody else's serialisation, and there is nothing to guess at.

  It is also verified rather than assumed. CI publishes a spec-compliant MPRIS
  player on a real session bus and drives the real `playerctl` against it,
  because with no player on the bus `playerctl` exits on "No players found"
  before it ever reads the template — so a green run without one proves nothing.

- **`upnext-http`**, first release. The queue over HTTP with a live SSE stream,
  loopback-only unless you set a token. Zero dependencies; the third transport
  alongside the CLI and MCP, and the same shape as both.

- `sendMpris`, `readMpris`, `parseMpris` and the platform-specific
  `readMediaRemote` / `sendMediaRemote` are exported by name, for anyone who
  wants one register rather than whichever this machine has.

### Fixed

- **`desktop()` registered Now Playing only on macOS**, so the Linux support
  above was invisible to everyone who starts there. The adapter already reports
  itself unavailable where it cannot reach a register, so the platform check
  bought nothing and hid a working backend. Its test asserted the old behaviour
  outright, which is how the gate survived gaining a second platform.

- **`readNowPlaying` and `sendTransport` reached MediaRemote directly**, which
  made everything built on them macOS-only regardless of the adapter —
  including the `upnext` CLI's `now`, `pause`, `resume`, `next` and `prev`.
  They now dispatch by platform. CI drives the CLI itself against the fixture
  player, since an adapter that works while the CLI does not is the exact shape
  of the bug.

## 0.2.0

**Breaking**, which is why this is a minor: `Capabilities` gained a required
`preload` field, so an adapter that builds a capability literal without
spreading `defaultCapabilities` will no longer compile.

### Added

- **Gapless playback.** A backend can now be handed the next item while the
  current one is still playing, through a new `preload` capability and an
  optional `preload(binding)` method. `upnext-adapter-browser` implements it by
  double buffering: give it a `spare` element and the next track loads into the
  idle one, so the switch at the end is instant instead of a fetch.

  This replaces the `nativeQueue` flag removed in 0.1.0, and is deliberately
  narrower. Whether a backend holds a list is neither necessary nor sufficient;
  what matters is whether it can be handed one thing early. Spotify and Apple
  Music still cannot be gapless from here — their AppleScript dictionaries offer
  no way to queue a track — and now say so rather than being listed as unbuilt.

  The offer is a hint, not an instruction: the queue can change, so a prepared
  item may never play, and a preload that fails costs the gap rather than the
  track.

- `FakeAdapter` records what it was offered, so a host can assert its own
  gapless behaviour.

### Fixed

- **`stop()` left the entry marked `active`** while playback was idle. A host
  rendering the queue showed a now-playing row over silence, and because
  `nextPlayable` skips active entries, `stop()` followed by `play()` jumped a
  track instead of resuming the one it stopped. Reaching the end of the queue
  still marks the entry `ended`.

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
