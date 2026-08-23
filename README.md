# upnext

[![npm](https://img.shields.io/npm/v/upnext-core?label=upnext-core)](https://www.npmjs.com/package/upnext-core)
[![CI](https://github.com/tothienbao6a0/upnext/actions/workflows/ci.yml/badge.svg)](https://github.com/tothienbao6a0/upnext/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![deps](https://img.shields.io/badge/dependencies-0-brightgreen)](./packages/core/package.json)

**One queue and one playback API over every audio source — built to be embedded in agent harnesses.**

Not a music player. Not an MCP server. A library your product imports so an agent
can control audio without knowing whether the sound is coming from Spotify, a
browser tab, a podcast feed, or a file on disk.

```ts
runtime.enqueue({ title: 'Bad Habit', artist: 'Steve Lacy' });  // → Spotify
runtime.enqueue('https://example.com/interview.mp3');           // → a stream
runtime.enqueue('file:///voice-memos/ruby.m4a');                // → local disk
runtime.enqueue('something calmer after those');                // → your agent decides, later

await runtime.play();
```

Four different sources. One queue. The agent never learns which is which.

---

## The problem

Every audio integration today puts the queue in the wrong place.

```
   WITHOUT upnext                          WITH upnext

   agent                                   agent
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

Want to hear it right now, with no files of your own?

```bash
git clone https://github.com/tothienbao6a0/upnext && cd upnext
npm install && npm run demo    # synthesizes its own tones and plays them
```

---

## How it works

### The pieces

```
                        your agent harness
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
        ┌───────────────┬───────┴───────┬───────────────┐
        ▼               ▼               ▼               ▼
   local files     browser tab       Spotify        anything
                                                   you write
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

Strong external ids (ISRC, MusicBrainz) are the join key; normalized title and
artist are the fallback. **Resolutions are verified before they play** — an
adapter returning *something* is not the same as it returning the right thing,
and confidently playing the wrong song is the classic cross-source failure.

### 2. Capabilities describe what a backend actually *is*

Every backend sits somewhere on this line, and the runtime is correct across all
of it:

```
  you own it completely  ◄──────────────────────────────►  someone else owns it

  local file            browser tab          Apple Music         Spotify app
  ───────────           ───────────          ───────────         ───────────
  process exit          'ended' event        must be polled      must be polled
  = end of track        = end of track
  exact position        exact position       exact position      exact position
  nobody else           nobody else          A HUMAN CAN         A HUMAN CAN
  can touch it          can touch it         HIT NEXT            HIT NEXT
```

```ts
{
  nativeQueue:     false,        // must the runtime drive every transition?
  endOfTrack:      'event',      // 'event' | 'poll' | 'none'
  position:        'estimated',  // 'authoritative' | 'estimated' | 'none'
  externalControl: true,         // can a human change this behind our back?
  seek: true, pause: true, volume: false, search: true,
}
```

`play: true` would be useless — every adapter can play. These are the flags that
change what the runtime and the agent actually *do*:

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

**The human wins by default.** An agent-owned queue that fights the person
holding the keyboard is a bug, not a feature.

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
> harness instead of being one agent with a `package.json`.

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

// reading
runtime.can(capability)  // what the loaded backend supports, right now
runtime.getState()       // { version, playback, nowPlaying, queue, adapters }
runtime.queue            // frozen read-only view
runtime.search(query, { limit, adapterId })

// events
runtime.on(event, handler)  // returns an unsubscribe function
```

### Why positions are ids, not indexes

```
   agent reads queue:   [0] Nights  [1] Ivy  [2] Pyramids
   agent decides:       "move index 2 to the front"
   meanwhile a human:   removes Nights
   agent's call lands:  moves Ivy.  Wrong song. No error.
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
| [**`upnext-adapter-process`**](https://www.npmjs.com/package/upnext-adapter-process) | adapters as subprocesses, in any language |

`upnext-core` does **no I/O at all** — no filesystem, no network, no clock it
wasn't handed. It runs identically in Node, Bun, Deno, Electron, Tauri or a
browser, and the entire suite runs in milliseconds with no fake-timer library
and no flakes.

---

## Status

Early, but the core, the capability model and the adapter contract are real and
tested. **93 tests**, CI on Node 20/22 across Linux and macOS.

Several bugs in this design were found by running the demo *out loud* rather than
by reading code — a doubled end-of-track event, a late prefetch overwriting the
track that had just started, two tracks playing at once after a cancelled skip.
Each has a regression test. If you touch playback, run `npm run demo` and listen.

**Not built yet:**

- **Gapless handoff into a native queue.** `nativeQueue` is reported honestly but
  not yet exploited, so same-backend transitions have a small gap.
- **Spotify and Apple Music adapters.** The first should probably wrap
  [spogo](https://github.com/openclaw/spogo) out-of-process; also watch
  [Spotify Soloist](https://developer.spotify.com/documentation/soloist), whose
  local WebSocket API is exactly the right shape (Linux-only today).
- **Browser adapter for existing tabs.** Needs an extension or CDP.
- **MCP / CLI / HTTP transports.** Thin adapters *on top of* the core, in
  separate packages, so nobody inherits a transport opinion.

---

## Contributing

The most valuable thing you can contribute is an **adapter** — see
[CONTRIBUTING.md](./CONTRIBUTING.md). The core is deliberately small and mostly
finished; what makes this useful is the number of places it can send audio.

Apache-2.0. Adoption is the only moat that matters for a substrate like this — a
queue abstraction is worthless unless other people's adapters target it.
