# @upnext/core

**One queue and one playback API over every audio source, built to be embedded in agent harnesses.**

Not a music player. Not an MCP server. A library your product imports so that an
agent — or a UI, or a script — can control audio without knowing whether the
sound is coming from Spotify, a browser tab, a podcast feed, or a file on disk.

```bash
npm i @upnext/core @upnext/adapter-local
```

```ts
import { Runtime } from '@upnext/core';
import { LocalAdapter } from '@upnext/adapter-local';

const runtime = new Runtime({ adapters: [new LocalAdapter()] });

runtime.enqueue({ title: 'Bad Habit', artist: 'Steve Lacy' });
runtime.enqueue('https://example.com/interview.mp3');
runtime.enqueue('something calmer after this');   // resolved later, by your host

await runtime.play();
```

## The idea

**The runtime owns the queue. Adapters are execution backends.**

Every existing integration inverts this — an agent calls the Spotify API, and
*Spotify's* queue is the real one. That works right up until the next item is a
YouTube video, and then there is nowhere to put it. Here, Spotify's queue, Apple
Music's Up Next and a browser tab's media element are all just places to send
one item at a time.

**Entries are descriptions, not URIs.** A `MediaRef` binds to a source as late
as possible, so an agent can enqueue something before knowing which backend will
play it, and the runtime can fall back to another source when one fails.

**Capabilities say what a backend really is** — whether it pushes end-of-track
events or must be polled, whether its position is real or extrapolated, whether
a human can change it behind your back. They are published inline on playback
state, so `runtime.can('seek')` is one call rather than a join.

## This package

Zero dependencies and no I/O at all — no filesystem, no network, no clock it
was not handed. It runs identically in Node, Bun, Deno, Electron, Tauri or a
browser, and the entire test suite executes in milliseconds with no fake-timer
library.

- `@upnext/core` — the runtime and the protocol
- `@upnext/core/testing` — a fake adapter whose capabilities you set
- `@upnext/core/internal` — the pieces it is built from. Unsupported; they move.

## Adapters

- [`@upnext/adapter-local`](https://www.npmjs.com/package/@upnext/adapter-local) — files and streams via `ffplay`/`afplay`
- [`@upnext/adapter-process`](https://www.npmjs.com/package/@upnext/adapter-process) — adapters in any language, over a pipe

Writing one is small: `id`, `capabilities`, `match`, `resolve`, `load`, `play`,
`stop`. Everything else is optional and gated by what you declare.

---

Full documentation, design notes and contribution guide:
**https://github.com/tothienbao6a0/upnext**

Apache-2.0
