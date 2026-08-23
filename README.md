# upnext

**One queue and one playback API over every audio source, built to be embedded in agent harnesses.**

Not a music player. Not an MCP server. A library your product imports so that an
agent — or a UI, or a script — can control audio without knowing whether the
sound is coming from Spotify, a browser tab, a podcast feed, or a file on disk.

```ts
import { Runtime } from '@upnext/core';
import { LocalAdapter } from '@upnext/adapter-local';

const runtime = new Runtime({ adapters: [new LocalAdapter()] });

runtime.enqueue({ title: 'Bad Habit', artist: 'Steve Lacy' });
runtime.enqueue('https://example.com/interview.mp3');
runtime.enqueue('something calmer after this');   // resolved later, by your host

await runtime.play();
```

## The one design decision everything follows from

**The runtime owns the queue. Adapters are execution backends.**

Every existing integration inverts this — an agent calls the Spotify API, and
*Spotify's* queue is the real one. That works right up until the next item is a
YouTube video, and then there is nowhere to put it.

Here, Spotify's queue, Apple Music's Up Next and a browser tab's single media
element are all just places to send one item at a time. Ordering, intent and
history live in the runtime, so an agent can line up a Spotify track, a YouTube
video and a voice memo in a row without knowing that any of those things exist.

```
       your agent harness
                │
          Runtime ── Queue · state · events
                │
      Binder ───┴─── Prefetcher
                │
   ┌────────────┼────────────┐
Spotify    browser/local    anything
adapter      adapter        else
```

## Two ideas that make it work

### Media is described, not located

A queue entry is not a URI. It is a `MediaRef` — a description that binds to a
source **as late as possible**.

```ts
{ title: 'Bad Habit', artist: 'Steve Lacy', isrc: 'USUM72209293' }
```

That is what lets an agent enqueue something before knowing which backend will
play it, what lets the runtime fall back to a different source when one fails
mid-queue, and what makes a queue portable between two people on different
streaming services. Strong external ids (ISRC, MusicBrainz) are the join key;
normalized title and artist are the fallback.

Resolutions are verified before they play. An adapter returning *something* is
not the same as it returning the right thing, and confidently playing the wrong
song is the classic cross-source failure.

### Capabilities describe what a backend actually is

Every backend sits somewhere between "I fully own this player" (a local file)
and "an authoritative external player a human can also touch" (the Spotify
desktop app). The runtime behaves correctly across that whole range, and an
agent can tell which end it is talking to:

```ts
{
  nativeQueue: false,          // must the runtime drive every transition?
  endOfTrack: 'event',         // 'event' | 'poll' | 'none' — how we learn a track finished
  position: 'estimated',       // 'authoritative' | 'estimated' | 'none' — how much to trust the clock
  externalControl: true,       // can a human change this behind our back?
  seek: true, pause: true, volume: false, search: true,
}
```

`play: true` would be useless — every adapter can play. These are the flags that
change what the runtime and the agent actually do.

They are published where they are needed rather than where they came from:
`getPlayback().capabilities` is the live backend's, inline, so answering "can I
seek right now?" is never a join against `adapterId`. There is a one-liner for
the common case:

```ts
if (runtime.can('seek')) await runtime.seek(30_000);
```

Calling a verb a backend does not support throws rather than silently doing
nothing — an agent that asked to seek needs to know the playhead did not move.
Asking for a state already reached (pausing what is not playing) is a no-op.

When a human *does* take over an external player, the default policy is that the
human wins: their choice is folded into the queue and playback carries on from
there. An agent-owned queue that fights the person holding the keyboard is a
bug, not a feature. (`desyncPolicy: 'adopt' | 'correct' | 'ignore'`.)

## The agent-facing API

```ts
runtime.enqueue(input, position?)      // MediaRef | uri string | intent string
runtime.enqueueMany(inputs, position?)
runtime.move(id, position, expectVersion?)
runtime.remove(id, expectVersion?)
runtime.clear({ keepActive })

runtime.play(id?)      runtime.playNow(input)
runtime.pause()        runtime.resume()      runtime.toggle()
runtime.next()         runtime.previous()
runtime.seek(ms)       runtime.setVolume(0..1)      runtime.stop()

runtime.search(query, { limit, adapterId })
runtime.can(capability)        // what the loaded backend supports, right now
runtime.getState()             // { version, playback, nowPlaying, queue, adapters }
runtime.queue                  // read-only view: list, get, upcoming, nextPlayable…
runtime.on('item:started' | 'queue:changed' | 'desync' | ..., handler)
```

Everything handed out is a copy, including event payloads, and `runtime.queue`
is a frozen view with no mutators on it — not a type-level `Readonly` that a
cast could defeat. Mutation only goes through the methods above, which are the
only paths that announce the change, re-run lookahead and keep the deck in step.

**Position is always addressed by id, never by index.** `move(item, 2)` is a
race the moment an agent and a human touch the queue at the same time — by the
time the agent's call lands, position 2 is a different song. So it is
`move(id, { after: otherId })`, every mutation bumps a `version`, and any
mutation can pass `expectVersion` to refuse a stale write.

### Intents are queue entries

```ts
runtime.enqueue('something calmer after this');
```

That entry stays unresolved until the playhead gets close, then calls the
resolver **your host supplies**:

```ts
new Runtime({
  resolveIntent: async (intent, ctx) => {
    // ctx.nowPlaying is what the listener actually just heard.
    return await yourModel.pickTrack(intent, ctx);
  },
});
```

The core never calls a model, never holds an API key, never picks a provider.
That boundary is what makes this embeddable in someone else's harness instead
of being one agent with a `package.json`. Without a resolver it falls back to
searching whatever adapters advertise `search`.

If an entry cannot be prepared ahead of time you hear about it then, via
`item:unresolvable`, rather than discovering it when the playhead arrives and
nothing comes out of the speakers. It is a warning, not a verdict: the entry
keeps its place and is retried in full when it comes up, because a backend that
was briefly unreachable during lookahead is usually fine a minute later.

### Failure is a first-class case

Three things look identical from a listener's chair — nothing is playing — and
the runtime distinguishes them.

**A backend that lies** is rejected when you register it. Capabilities are
promises about behaviour, and most are only deliverable through a specific
optional method, so declaring `endOfTrack: 'event'` without a `subscribe` would
quietly never advance the queue. `addAdapter` throws instead, listing every
inconsistency at once with the fix in the message.

**A backend that breaks** is taken out of the running. If its `init` fails it is
not chosen, and `getState().adapters` reports `available: false` with the
reason — so an agent can tell "no Spotify" from "Spotify is down".

**A backend that never answers** is the dangerous one, because an unbounded wait
means the queue stops forever with no error at all. Every call out of the
library — adapter methods and your intent resolver — is bounded by `timeoutMs`
(30s default, `null` to disable), which turns a hang into an ordinary failure
that falls through to the next source.

Cancellation stops what it cancels. Skipping while a backend is mid-`play`
tells that backend to stop rather than leaving it running alongside whatever
started next, which is otherwise two tracks at once.

### Events are per logical change, not per write

Starting a track touches the queue five times internally. Subscribers get one
`queue:changed` carrying the settled state, because a host rendering a list
should not repaint five times for what a person would call one change. Reads
are never deferred — only the telling is, so an agent that enqueues and
immediately calls `getState()` always sees its own write.

## Writing an adapter

Required: `id`, `capabilities`, `match`, `resolve`, `load`, `play`, `stop`.
Everything else is optional and gated by capabilities, so a thirty-line adapter
is a legitimate adapter.

```ts
class MyAdapter implements Adapter {
  id = 'mine';
  capabilities = { ...defaultCapabilities, endOfTrack: 'event', pause: true };

  match(ref) { return ref.uri?.startsWith('mine:') ? 1 : 0; }
  async resolve(ref) { return { adapterId: this.id, nativeUri: ref.uri, ref }; }
  async load(binding) { /* ... */ }
  async play() { /* ... */ }
  async stop() { /* ... */ }
  subscribe(listener) { /* call listener({ type: 'ended' }) */ }
}
```

### …in any language

Adapters do not have to be TypeScript, or even in this process. `@upnext/adapter-process`
runs a subprocess speaking newline-delimited JSON — one object per line, no
framing, no codegen:

```
→  {"id": 1, "method": "resolve", "params": {"ref": {...}}}
←  {"id": 1, "result": {...}}
←  {"event": {"type": "ended"}}
```

`packages/adapter-process/examples/python-adapter/adapter.py` is a complete
working backend in ~150 lines of Python, and it is covered by the test suite —
the runtime cannot tell it apart from a native one. Most of the people who can
write a good Spotify or Apple Music backend are not going to write it in
TypeScript, and the adapter ecosystem is the entire point.

## Packages

| package | what it is |
| --- | --- |
| `@upnext/core` | queue, state machine, capabilities, events. **Zero dependencies, no I/O.** |
| `@upnext/core/testing` | a fake adapter whose capabilities you set, for testing your host. |
| `@upnext/core/internal` | the pieces the runtime is built from. Unsupported, and they will move. |
| `@upnext/adapter-local` | files and streams via `ffplay`/`afplay`. No credentials, no accounts. |
| `@upnext/adapter-process` | run an adapter as a subprocess in any language. |
| `@upnext/demo` | the whole thing end to end, out loud. |

`@upnext/core` does no I/O at all: it is a pure state machine with an injectable
clock, so it runs identically in Node, Bun, Deno, Electron, Tauri or a browser,
and the entire test suite executes in milliseconds with no fake-timer library
and no flakes.

## Try it

```bash
npm install
npm test        # 93 tests
npm run demo    # makes actual sound — no assets, no downloads
```

The demo generates its own tones, so it works on any machine with `ffplay` or
`afplay` and nothing else installed.

## Status

Early, but the core, the capability model and the adapter contract are real and
tested. Three bugs in this design were found by running the demo out loud rather
than by reading the code, and each has a regression test — that is worth keeping
as a habit as adapters are added.

Deliberately **not** built yet:

- **Gapless handoff into a native queue.** `nativeQueue` is reported honestly
  but not yet exploited, so same-backend transitions have a small gap.
- **Spotify and Apple Music adapters.** Both are real work — the first should
  probably wrap [spogo](https://github.com/openclaw/spogo) out-of-process, and
  watch [Spotify Soloist](https://developer.spotify.com/documentation/soloist),
  whose local WebSocket API is exactly the right shape (Linux-only today).
- **Browser adapter for existing tabs.** Needs an extension or CDP. The
  contract is ready for it.
- **MCP / CLI / HTTP transports.** These are thin adapters *on top of* the core,
  not part of it, and they should stay in separate packages so nobody inherits
  a transport opinion they did not ask for.

## License

Apache-2.0. Adoption is the only moat that matters for a substrate like this —
a queue abstraction is worthless unless other people's adapters target it.
