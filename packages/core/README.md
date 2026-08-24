# upnext-core

[![npm](https://img.shields.io/npm/v/upnext-core)](https://www.npmjs.com/package/upnext-core)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/tothienbao6a0/upnext/blob/main/LICENSE)
[![deps](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/upnext-core)

**One queue and one playback API over every audio source.**

```ts
runtime.enqueue('spotify:track:1OWBh1eVxUdA1Z6UA8r4nh');  // → the Spotify app
runtime.enqueue('https://example.com/interview.mp3');     // → a stream
runtime.enqueue('file:///voice-memos/ruby.m4a');          // → local disk
runtime.enqueue('something calmer after those');          // → resolved later, by you

await runtime.play();
```

Four sources. One queue. The caller never learns which is which.

**Shaped by the agentic age; not only for agents.** The design assumes what
building software is like now: more than one thing writes to the queue, and
nobody can afford a backend that lies about what it can do. Agent harnesses are
the sharpest case — a desktop player, a kiosk or a car UI is a first-class user
here too.

## The idea

Every audio integration today puts the queue in the wrong place.

```
   WITHOUT                                 WITH upnext

   caller ─► Spotify API             caller ─► ┌───────────┐
                 │                              │ THE QUEUE │ ← yours
                 ▼                              └─────┬─────┘
           ┌───────────────┐               ┌──────┬───┴───┬───────┐
           │ Spotify queue │ ← the real    ▼      ▼       ▼       ▼
           └───────────────┘      one   Spotify Apple  browser  local

   Queue a YouTube video next.            Each just plays what it's handed.
   Nowhere to put it.
```

**The runtime owns the queue. Adapters are execution backends.** Spotify's queue,
Apple Music's Up Next and a browser tab's `<audio>` element all become places to
send one item at a time.

## Install

```bash
npm i upnext-core upnext-adapter-local
```

```ts
import { Runtime } from 'upnext-core';
import { LocalAdapter } from 'upnext-adapter-local';

const runtime = new Runtime({ adapters: [new LocalAdapter()] });

runtime.on('item:started', ({ item }) => console.log('▶', item.ref.title));

runtime.enqueue('file:///path/to/song.mp3');
await runtime.play();
```

## Two ideas that make it work

### Media is described, not located

A queue entry is not a URI. It's a `MediaRef` that binds to a source **as late as
possible** — so you can enqueue before choosing a source, fall back automatically
when one fails mid-queue, and share a queue between people on different services.

```ts
{ title: 'Bad Habit', artist: 'Steve Lacy', isrc: 'USUM72209293' }
```

Resolutions are verified before they play. An adapter returning *something* isn't
the same as it returning the right thing.

### Capabilities say what a backend actually is

```
  you own it completely  ◄─────────────────────────────►  someone else owns it

  local file                browser tab            Spotify desktop app
  process exit = done       'ended' event          must be watched
  nobody else touches it                           A HUMAN CAN HIT NEXT
```

```ts
if (runtime.can('seek')) await runtime.seek(30_000);
```

Capabilities are published inline on playback state, so that's one call rather
than a join against `adapterId`. `play: true` would be useless — every adapter
can play. `endOfTrack`, `position` and `externalControl` are the flags that
change what the runtime and the caller actually do.

When a human *does* take over an external player, the default is that **the human
wins** — their choice folds into the queue and playback carries on.

## Intents are queue entries

```ts
runtime.enqueue('something calmer after this');

new Runtime({
  resolveIntent: async (intent, ctx) => yourModel.pickTrack(intent, ctx),
});
```

The entry stays unresolved until the playhead nears it, then calls the resolver
**your host supplies**. The core never calls a model, never holds an API key,
never picks a provider — that boundary is what makes this embeddable in someone
else's product.

## The queue outlives the process, and the backends

```ts
runtime.setRepeat('all');    // 'off' | 'one' | 'all' — repeat-one still yields to next()
runtime.setShuffle(true);    // a traversal order, not a re-ordering of your list

const saved = runtime.serialize();            // plain JSON
const { positionMs } = runtime.restore(saved); // replaces the queue, starts nothing
```

Repeat and shuffle live here rather than on an adapter because they are
properties of *the queue*: Spotify has its own repeat button, so does Apple
Music, and neither knows about the browser tab queued behind it.

`restore` drops every binding, because a binding is a live handle to a backend
session and none of that survives a restart. Each entry rebinds against the
adapters that exist now — which is the payoff for describing media rather than
locating it: a queue saved on a machine with Spotify reopens on one without it
and still plays.

## Entry points

| import | what it is |
|---|---|
| `upnext-core` | the runtime and the protocol |
| `upnext-core/testing` | a fake adapter whose capabilities you set |
| `upnext-core/internal` | the pieces it's built from. Unsupported; they move. |

## Adapters

- [`upnext-adapter-local`](https://www.npmjs.com/package/upnext-adapter-local) — files and streams via `ffplay`/`afplay`
- [`upnext-adapter-spotify`](https://www.npmjs.com/package/upnext-adapter-spotify) — the Spotify desktop app (macOS, no credentials) or the Web API
- [`upnext-adapter-process`](https://www.npmjs.com/package/upnext-adapter-process) — adapters in any language, over a pipe

Writing one is small: `id`, `capabilities`, `match`, `resolve`, `load`, `play`,
`stop`. Everything else is optional and gated by what you declare.

## About this package

**Zero dependencies and no I/O at all** — no filesystem, no network, no clock it
wasn't handed. It runs identically in Node, Bun, Deno, Electron, Tauri or a
browser, and its whole test suite executes in milliseconds with no fake-timer
library.

---

Diagrams, API reference, failure semantics and the adapter guide:
**https://github.com/tothienbao6a0/upnext**

Apache-2.0
