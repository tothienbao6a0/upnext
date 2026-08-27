# upnext

[![npm](https://img.shields.io/npm/v/upnext-core?label=upnext-core)](https://www.npmjs.com/package/upnext-core)
[![CI](https://github.com/tothienbao6a0/upnext/actions/workflows/ci.yml/badge.svg)](https://github.com/tothienbao6a0/upnext/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![deps](https://img.shields.io/badge/dependencies-0-brightgreen)](./packages/core/package.json)

**One queue over every audio source — including the ones you don't control.**

A library your product imports so that whatever is driving — a model, a person
clicking, a script — can control audio without knowing whether the sound is
coming from Spotify, a browser tab, a podcast feed, or a file on disk.

```ts
const runtime = new Runtime({ adapters: [spotify, browser, local, nowPlaying] });

runtime.enqueue(NOW_PLAYING_URI);                         // the podcast already
                                                          // playing in their browser
runtime.enqueue('spotify:track:1OWBh1eVxUdA1Z6UA8r4nh');  // then a Spotify track
runtime.enqueue('https://example.com/episode.mp3');       // then a file on the web
runtime.enqueue('something calmer after those');          // then whatever you decide, later

await runtime.play();
```

Four sources, one list, in order. The first one is playing inside an app you do
not own — and the queue waits for it to finish before taking over.

### What you get

**Add audio to your product without marrying one service.** Write against one
queue; swap or add backends later. An entry describes *what to play*, not *where
from*, so it can bind to whichever source is available at the moment it plays.

**Join what someone is already listening to instead of talking over it.** The
machine's current playback — a YouTube tab, a podcast in Safari, VLC — can be a
queue entry like any other. Your track starts when theirs ends.

**Know what you can do before you try it.** `runtime.can('seek')` answers for the
backend that is actually loaded. No silent no-ops, no discovering at 2am that
one source quietly ignored a command.

**Keep playing when a source fails.** If a backend cannot load an entry, the same
description is handed to the next one that can. A queue does not stop because
one service is down.

**Survive a restart.** `serialize()` / `restore()` — and a queue saved on a
machine with Spotify reopens on one without it, then plays from somewhere else.

### What ships today

| package | plays |
|---|---|
| **`upnext-core`** | nothing — the queue, state machine, capability model and events. Zero dependencies, no I/O. |
| **`upnext-adapter-spotify`** | the Spotify **desktop app** on macOS with no credentials, or the **Web API** with a token you hold |
| **`upnext-adapter-browser`** | any media element you control — browser, Electron renderer, webview, across a process boundary |
| **`upnext-adapter-local`** | local files and streams via `ffplay`/`afplay` |
| **`upnext-adapter-apple-music`** | your Apple Music library through the **Music app** — no credentials, **and it can search** |
| **`upnext-adapter-nowplaying`** | whatever **macOS** is already playing, whichever app is playing it |
| **`upnext-adapter-process`** | an adapter written in any language, over a pipe |
| **`upnext-desktop`** | all of the above wired for you, in one call — plus the `upnext` CLI |
| **`upnext-mcp`** | the same, as an MCP server any agent can use |

### What each one can actually do

The point of the capability model is that these differ, and say so:

| | starts tracks | end of track | position | seek | pause | volume | search | someone else can change it |
|---|:---:|---|---|:---:|:---:|:---:|:---:|:---:|
| **browser** | ✅ | `event` | exact | ✅ | ✅ | ✅ | ❌ | no |
| **local** (ffplay) | ✅ | `event` | estimated | ✅ | ✅ | ❌ | ✅¹ | no |
| **local** (afplay) | ✅ | `event` | estimated | ❌ | ✅ | ❌ | ✅¹ | no |
| **spotify** desktop | ✅ | `event` | exact | ✅ | ✅ | ✅ | ❌² | **yes** |
| **spotify** web | ✅ | `event` | exact | ✅ | ✅ | ✅ | ✅ | **yes** |
| **apple music** | ✅ | `poll` | exact | ✅ | ✅ | ✅ | **✅** | **yes** |
| **nowplaying** | ❌³ | `poll` | exact | ❌ | ✅ | ❌ | ❌ | **yes** |

¹ only when you point it at a music folder to index · ² the AppleScript
dictionary cannot search a catalogue · ³ there is no way to ask macOS's Now
Playing register to start a specific track

Every ❌ there is a refusal rather than a silent failure. An adapter that claims
it can seek and then doesn't is a bug you chase for an hour; these tell you
first, and the runtime routes around them.

**Not built yet:** gapless handoff into a native queue, Now Playing on Windows
and Linux, controlling one *specific* browser tab (needs an extension), and an
HTTP transport. Details at the [bottom](#not-built-yet).

---

## The problem

Every audio integration today puts the queue in the wrong place.

```
   WITHOUT upnext                          WITH upnext

   caller                                  caller
     │                                       │
     │ "play X"                              │ enqueue / move / skip
     ▼                                       ▼
   Spotify Web API                     ┌───────────────┐
     │                                 │   THE QUEUE   │ ← yours. one of them.
     ▼                                 └───────┬───────┘
   ┌───────────────┐                           │
   │ Spotify queue │ ← the real one    ┌───────┼───────┬────────┐
   └───────────────┘                   ▼       ▼       ▼        ▼
                                    Spotify  Apple  browser   local
   Now queue a YouTube video.                 Music    tab      file
   Nowhere to put it.               Each one just plays what it's handed.
```

That works right up until the next item isn't a Spotify track — and then there is
nowhere to put it. **upnext inverts it:** the runtime owns the queue, and Spotify's
queue, Apple Music's Up Next and a browser tab's `<audio>` element all become
places to send *one item at a time*.

---

## Quickstart

The fast way — every source this machine can reach, one call:

```bash
npm i upnext-desktop
```

```ts
import { desktop } from 'upnext-desktop';

const audio = await desktop();
audio.enqueue('spotify:track:1OWBh1eVxUdA1Z6UA8r4nh');
audio.enqueue('https://example.com/podcast.mp3');
await audio.play();
```

It ships a CLI too:

```
$ upnext now
▶ Korea's STRANGEST Food is on Jeju Island!! — More Best Ever Food Review Show
  Google Chrome · 23:20 / 24:11
```

That is a YouTube tab, read with no browser extension.

### Or give it to an agent

```json
{ "mcpServers": { "upnext": { "command": "npx", "args": ["-y", "upnext-mcp"] } } }
```

Twelve tools in Claude Desktop, Cursor or anything else that speaks MCP —
including `media_adopt_current`, which puts what someone is already listening to
into the queue so the agent adds to it rather than talking over it.

### Or wire it yourself

```bash
npm i upnext-core upnext-adapter-local
```

`upnext-adapter-local` needs `ffplay` (from ffmpeg) or `afplay` (built into macOS).

```ts
import { Runtime } from 'upnext-core';
import { LocalAdapter } from 'upnext-adapter-local';

const runtime = new Runtime({
  // Absolute paths only — Node does not expand `~`.
  adapters: [new LocalAdapter({ library: ['/Users/you/Music'] })],
});

runtime.on('item:started', ({ item }) => console.log('▶', item.ref.title));
runtime.on('item:ended',   ({ item }) => console.log('■', item.ref.title));

runtime.enqueue('file:///path/to/first.mp3');
runtime.enqueue('file:///path/to/second.mp3');

await runtime.play();     // plays the first, then the second, on its own
await runtime.next();     // skip
```

On a Mac with Spotify open, add a second source with nothing to sign up for:

```bash
npm i upnext-adapter-spotify
```

```ts
import { SpotifyDesktopAdapter } from 'upnext-adapter-spotify';

const runtime = new Runtime({
  adapters: [new LocalAdapter({ library: ['/Users/you/Music'] }), new SpotifyDesktopAdapter()],
});

runtime.enqueue('https://open.spotify.com/track/1OWBh1eVxUdA1Z6UA8r4nh');
runtime.enqueue('file:///path/to/second.mp3');
await runtime.play();   // Spotify, then a local file, without either knowing
```

Want to hear it right now, with no files of your own?

```bash
git clone https://github.com/tothienbao6a0/upnext && cd upnext
npm install && npm run demo    # synthesizes its own tones and plays them
```

---

## How it works

### The pieces

```
                          your application
                                │
   ┌────────────────────────────┼────────────────────────────┐
   │  Runtime                   ▼                            │
   │  ┌──────────┐  ┌──────────────┐  ┌────────────────┐     │
   │  │  Queue   │  │    Binder    │  │   Prefetcher   │     │
   │  │ ordered  │  │ which source │  │  resolve ahead │     │
   │  │ id-based │  │  + fallback  │  │  of the head   │     │
   │  └──────────┘  └──────────────┘  └────────────────┘     │
   │  ┌──────────┐  ┌──────────────┐  ┌────────────────┐     │
   │  │   Deck   │  │   Watcher    │  │   Reconciler   │     │
   │  │  loaded  │  │  is it over  │  │  human took    │     │
   │  │   item   │  │     yet?     │  │      over      │     │
   │  └──────────┘  └──────────────┘  └────────────────┘     │
   └────────────────────────────┬────────────────────────────┘
                                │  Adapter interface
    ┌──────────┬──────────┬────────┴───┬──────────┬──────────┐
    ▼          ▼          ▼            ▼          ▼          ▼
 Spotify    Spotify    a media      local     whatever    anything
 desktop    Web API     element     files      is on      you write
                     (browser /              (macOS Now
                      Electron)               Playing)
```

### The life of one queue entry

```
  runtime.enqueue('something calmer')
              │
              ▼
        ┌──────────┐   your resolveIntent()    ┌────────────┐
        │ pending  │ ────────────────────────► │ unresolved │
        └──────────┘   "calmer" → a MediaRef   └─────┬──────┘
                                                     │ Binder picks a source
                                                     ▼
                                               ┌───────────┐
                                               │   ready   │  bound, not yet playing
                                               └─────┬─────┘
                                                     │ play()
                                                     ▼
                                               ┌───────────┐
                                               │  active   │  ◄── Watcher is watching
                                               └─────┬─────┘
                              ┌──────────────────────┼──────────────────────┐
                              ▼                      ▼                      ▼
                        ┌──────────┐           ┌──────────┐           ┌──────────┐
                        │  ended   │           │ skipped  │           │  failed  │
                        └──────────┘           └──────────┘           └──────────┘
```

Entries are prepared **before** the playhead reaches them, so an intent has
already become a real track on a real backend by the time it's needed — no
silence while a model thinks.

### What `play()` actually does

```
1.  detach the deck, stop whatever was playing
2.  mark the entry loading
3.  intent?  ──► call your resolveIntent()          ──► MediaRef
4.  Binder scores every adapter with match(ref)
5.       ├─ resolve()      ──► a Binding
6.       ├─ confidence check: is this actually the song asked for?   ← ⚠ the big one
7.       ├─ load()
8.       └─ play()                    any step fails ──► try the next source
9.  Deck attaches, Watcher arms end-of-track detection
10. emit item:started + one queue:changed
```

---

## The two ideas that make it work

### 1. Media is described, not located

A queue entry is **not a URI**. It's a `MediaRef` — a description that binds to a
source as late as possible.

```ts
{ title: 'Bad Habit', artist: 'Steve Lacy', isrc: 'USUM72209293' }
```

| this gives you | because |
|---|---|
| enqueue before choosing a source | the entry doesn't name one |
| automatic fallback mid-queue | if Spotify fails to load, the same ref goes to the next adapter |
| queues portable between people | your Spotify and their Apple Music resolve the same ISRC |
| queues that survive a restart | a saved queue reopens on a machine with different backends and still plays |

Strong external ids (ISRC, MusicBrainz) are the join key; normalized title and
artist are the fallback. **Resolutions are verified before they play** — an
adapter returning *something* is not the same as it returning the right thing,
and confidently playing the wrong song is the classic cross-source failure.

> **A title needs a backend that can search.** A link says exactly what to play;
> a title has to be looked up, and not every backend can look things up. The
> Spotify *desktop* app is the sharp case — it plays a URI you hand it, but its
> AppleScript dictionary cannot search a catalogue, so it scores **0** for a bare
> title rather than guessing. On a default Mac setup that means nothing resolves
> `{ title: 'Bad Habit' }`.
>
> On a Mac this is now answered for you: `upnext-adapter-apple-music` searches
> your library and needs no credentials at all, so a plain title resolves out of
> the box. Elsewhere, index a music folder, add a Spotify Web token, or supply
> `resolveIntent` and answer it yourself. `upnext-desktop`'s `explainSetup()`
> and `upnext doctor` both say which of those you have — this is a real gap and
> it is better named than discovered.

### 2. Capabilities describe what a backend actually *is*

Every backend sits somewhere on this line, and the runtime is correct across all
of it:

```
  you own it completely  ◄──────────────────────────────►  someone else owns it

  local file            browser tab          Apple Music         Spotify app
  ───────────           ───────────          ───────────         ───────────
  process exit          'ended' event        must be polled      must be watched
  = end of track        = end of track
  exact position        exact position       exact position      exact position
  nobody else           nobody else          A HUMAN CAN         A HUMAN CAN
  can touch it          can touch it         HIT NEXT            HIT NEXT
```

```ts
{
  endOfTrack:      'event',      // 'event' | 'poll' | 'none'
  position:        'estimated',  // 'authoritative' | 'estimated' | 'none'
  externalControl: true,         // can a human change this behind our back?
  seek: true, pause: true, volume: false, search: true,
}
```

`play: true` would be useless — every adapter can play. These are the flags that
change what the runtime and the caller actually *do*:

| flag | if it's weak, the runtime… |
|---|---|
| `endOfTrack: 'poll'` | asks on an interval instead of being told |
| `endOfTrack: 'none'` | runs a duration timer and marks the position a guess |
| `position: 'estimated'` | extrapolates from a local clock |
| `externalControl: true` | reconciles instead of assuming it's the only writer |

They're published **inline on playback state**, so this is one call, not a join
against `adapterId`:

```ts
if (runtime.can('seek')) await runtime.seek(30_000);
```

#### Worked example: the same service, twice

`upnext-adapter-spotify` ships two adapters for Spotify, and they are not
interchangeable:

| | desktop app | Web API |
|---|---|---|
| credentials | **none** | OAuth token + Premium |
| `search` | **`false`** | `true` |
| runs on | macOS | anywhere |

`search: false` is the interesting one. Spotify's AppleScript dictionary cannot
search a catalogue. That could be faked — scrape something, guess — and then
every resolution of a title would be a coin flip dressed as a lookup. **An adapter
that says it cannot do a thing is correct and slightly limited; one that says it
can and then does it badly is broken.** So it declares `false`, scores `0` on
anything that isn't already a Spotify link, and the entry goes to a backend that
can actually find it.

That is the whole capability model in one flag, and it is why capabilities belong
to an adapter rather than to a service.

---

## When a human takes over

You queue three songs. The listener picks up their phone and hits next in Spotify.

```
   runtime thinks:   ▶ Nights          backend is actually playing:  ▶ Ivy
                       ↑                                               ↑
                       └───────────────── desync ──────────────────────┘

   policy 'adopt'    (default)  →  Ivy becomes a real queue entry, playback continues
   policy 'correct'             →  force the backend back to Nights
   policy 'ignore'              →  report it, change nothing
```

**The human wins by default.** A queue that fights the person holding the
keyboard is a bug, not a feature.

The hard part is that "the track I loaded is not the track that is playing" has
two opposite causes — our track *ended and the backend rolled on*, or a person
*chose something else* — and they call for opposite responses. What separates
them is where the playhead was a moment ago, which is knowledge only the adapter
has. See [`adapter-spotify/src/sampler.ts`](./packages/adapter-spotify/src/sampler.ts)
for the real one.

---

## Intents are queue entries

```ts
runtime.enqueue('something calmer after this');
```

That entry stays unresolved until the playhead gets close, then calls the
resolver **your host supplies**:

```ts
new Runtime({
  resolveIntent: async (intent, ctx) => {
    // ctx.nowPlaying is what the listener actually just heard
    return await yourModel.pickTrack(intent, ctx);
  },
});
```

> **The core never calls a model, never holds an API key, never picks a
> provider.** That boundary is what makes this embeddable in someone else's
> product instead of being one agent with a `package.json`. The Spotify adapter
> draws the same line around OAuth: you supply `getAccessToken`, it runs no flow.

Without a resolver it falls back to searching whatever adapters advertise
`search`, so it's useful with nothing but adapters wired up.

---

## API

```ts
// queue — always addressed by stable id, never by index
runtime.enqueue(input, position?)          // MediaRef | uri string | intent string
runtime.enqueueMany(inputs, position?)
runtime.move(id, { after: otherId }, expectVersion?)
runtime.remove(id, expectVersion?)
runtime.clear({ keepActive })

// transport
runtime.play(id?)        runtime.playNow(input)
runtime.pause()          runtime.resume()        runtime.toggle()
runtime.next()           runtime.previous()
runtime.seek(ms)         runtime.setVolume(0..1)  runtime.stop()

// how the queue is traversed
runtime.setRepeat('off' | 'one' | 'all')
runtime.setShuffle(true)

// surviving a restart
runtime.serialize()      // plain JSON — store it wherever
runtime.restore(state)   // → { positionMs }; replaces the queue, starts nothing

// reading
runtime.can(capability)  // what the loaded backend supports, right now
runtime.getState()       // { version, repeat, shuffle, playback, nowPlaying, queue, adapters }
runtime.queue            // frozen read-only view
runtime.search(query, { limit, adapterId })

// events
runtime.on(event, handler)  // returns an unsubscribe function
```

### Repeat and shuffle live above the backends

Spotify has a repeat button. So does Apple Music. Neither knows about the browser
tab queued behind it, so the only place the question can be answered once is
above all of them. The adapters don't touch their backend's own setting.

Two details worth knowing: **repeat-one still yields to `next()`**, because a
repeat mode that ignores the skip button is a trap; and **shuffle is a traversal
order, not a re-ordering** — your list stays in the order you built it, and the
runtime just picks differently. Inject `random` to make a shuffle reproducible in
a test.

### Surviving a restart

```ts
await fs.writeFile('queue.json', JSON.stringify(runtime.serialize()));

// …next launch
const { positionMs } = runtime.restore(JSON.parse(await fs.readFile('queue.json', 'utf8')));
await runtime.play();
await runtime.seek(positionMs);
```

Restoring **never starts playback** — that's the host's call. And **bindings are
dropped**: a binding is a live handle to a backend session, and none of that
survives a restart, so every entry rebinds against the adapters that exist *now*.

Which is the payoff for describing media instead of locating it: a queue saved on
a machine with Spotify reopens on one without it, and still plays from somewhere
else.

### Why positions are ids, not indexes

```
   caller reads queue:  [0] Nights  [1] Ivy  [2] Pyramids
   caller decides:      "move index 2 to the front"
   meanwhile a human:   removes Nights
   the call lands:      moves Ivy.  Wrong song. No error.
```

So it's `move(id, { after: otherId })`. Every mutation bumps a `version`, and any
mutation can pass `expectVersion` to refuse a stale write.

### Events

| event | when |
|---|---|
| `item:started` / `item:ended` | a track began / finished, with the reason |
| `item:resolved` | an intent became a real `MediaRef` |
| `item:unresolvable` | lookahead failed — a warning, retried at play time |
| `item:failed` | this entry cannot play |
| `queue:changed` | **one per logical change**, not one per internal write |
| `playback:changed` | status, position source, capabilities |
| `position` | playhead moved |
| `desync` | a human changed the backend under us |
| `adapter:error` / `error` | a backend, or work nobody was awaiting, failed |

Everything handed out is a **copy**, including event payloads. `runtime.queue` is
a frozen view with no mutators on it — not a type-level `Readonly` a cast could
defeat.

---

## Failure is a first-class case

Three things look identical from a listener's chair — nothing is playing — so the
runtime tells them apart:

| what went wrong | what happens |
|---|---|
| **a backend lies** — claims `endOfTrack: 'event'` with no `subscribe` | rejected at `addAdapter`, listing every inconsistency at once |
| **a backend breaks** — `init()` throws | excluded from selection; `getState().adapters` shows `available: false` and why |
| **a backend hangs** — never returns | bounded by `timeoutMs` (30s default); falls through to the next source |
| **you change your mind** — skip mid-`play` | the abandoned backend is *stopped*, not left playing alongside the new one |
| **you use it after `dispose()`** | throws, rather than accepting a write to a queue nobody will ever hear |

---

## Writing an adapter

Required: `id`, `capabilities`, `match`, `resolve`, `load`, `play`, `stop`.
Everything else is optional and gated by what you declare — a thirty-line adapter
is a legitimate adapter.

```ts
import { defaultCapabilities, type Adapter } from 'upnext-core';

class MyAdapter implements Adapter {
  id = 'mine';
  capabilities = { ...defaultCapabilities, endOfTrack: 'event', pause: true };

  match(ref)          { return ref.uri?.startsWith('mine:') ? 1 : 0; }
  async resolve(ref)  { return { adapterId: this.id, nativeUri: ref.uri, ref }; }
  async load(binding) { /* … */ }
  async play()        { /* … */ }
  async stop()        { /* … */ }
  subscribe(listener) { /* call listener({ type: 'ended' }) when a track finishes */ }
}
```

Two rules that matter more than the code:

1. **Declare capabilities honestly.** When in doubt, declare the weaker thing. A
   backend that says it can't seek is correct and slightly limited; one that says
   it can and then doesn't is broken.
2. **Return `null` from `resolve` rather than guessing.** The runtime tries the
   next source, which beats confidently playing the wrong song.

### …in any language

Adapters don't have to be TypeScript, or even in this process.

```
   host                                 your child process
   ────                                 ──────────────────
   → {"id":1,"method":"init"}
                                        ← {"id":1,"result":{"capabilities":{…}}}
   → {"id":2,"method":"resolve", …}
                                        ← {"id":2,"result":{"nativeUri":"…"}}
   → {"id":3,"method":"play"}
                                        ← {"event":{"type":"ended"}}
```

One JSON object per line. No framing headers, no schema registry, no codegen.
[`examples/python-adapter/adapter.py`](./packages/adapter-process/examples/python-adapter/adapter.py)
is a complete working backend in ~150 lines of Python, covered by the test suite —
the runtime can't tell it apart from a native one.

---

## Packages

| package | what it is |
|---|---|
| [**`upnext-core`**](https://www.npmjs.com/package/upnext-core) | queue, state machine, capabilities, events. **Zero dependencies, no I/O.** |
| `upnext-core/testing` | a fake adapter whose capabilities you set |
| `upnext-core/internal` | the pieces it's built from. Unsupported; they move. |
| [**`upnext-adapter-local`**](https://www.npmjs.com/package/upnext-adapter-local) | files and streams via `ffplay`/`afplay`. No credentials. |
| [**`upnext-adapter-spotify`**](https://www.npmjs.com/package/upnext-adapter-spotify) | the Spotify desktop app (macOS, no credentials) or the Web API (your token) |
| [**`upnext-adapter-process`**](https://www.npmjs.com/package/upnext-adapter-process) | adapters as subprocesses, in any language |

`upnext-core` does **no I/O at all** — no filesystem, no network, no clock it
wasn't handed. It runs identically in Node, Bun, Deno, Electron, Tauri or a
browser, and the entire suite runs in milliseconds with no fake-timer library
and no flakes.

---

## Status

Early, but the core, the capability model and the adapter contract are real and
tested. **325 tests**, CI on Node 20/22 across Linux and macOS.

Several bugs in this design were found by running the demo *out loud* rather than
by reading code — a doubled end-of-track event, a late prefetch overwriting the
track that had just started, two tracks playing at once after a cancelled skip.
Each has a regression test. If you touch playback, run `npm run demo` and listen.

<a name="not-built-yet"></a>

**Not built yet:**

- **Windows and Linux equivalents of Now Playing.** Both have one — SMTC on
  Windows, MPRIS on Linux — and the adapter's shape would carry over. Only macOS
  is implemented.
- **Controlling one *specific* browser tab.** `upnext-adapter-nowplaying` already
  reaches whatever the machine is playing, browser included, through macOS's
  system Now Playing register — no extension needed. Singling out *one* tab among
  several, though, does need a browser extension, and that is a control feature
  rather than a queue one: you cannot queue into a tab you do not own.
- **Gapless handoff into a native queue.** Same-backend transitions have a small
  gap, because the runtime drives every one of them. (There *was* a `nativeQueue`
  capability describing this. It was declared, defaulted, and read by nothing —
  not even the validator — so it was removed rather than left as decoration in a
  contract whose whole claim is that capabilities are honest. It comes back in a
  minor version if the handoff does.)
- **An HTTP transport.** MCP and a CLI both ship now (`upnext-mcp`,
  `upnext-desktop`); HTTP would follow the same shape — a thin package on top of
  the core, so nobody importing the runtime inherits a transport opinion.

---

## Contributing

The most valuable thing you can contribute is an **adapter** — see
[CONTRIBUTING.md](./CONTRIBUTING.md). The core is deliberately small and mostly
finished; what makes this useful is the number of places it can send audio.

Apache-2.0. Adoption is the only moat that matters for a substrate like this — a
queue abstraction is worthless unless other people's adapters target it.
