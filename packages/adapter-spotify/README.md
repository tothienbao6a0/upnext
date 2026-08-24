# upnext-adapter-spotify

[![npm](https://img.shields.io/npm/v/upnext-adapter-spotify)](https://www.npmjs.com/package/upnext-adapter-spotify)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/tothienbao6a0/upnext/blob/main/LICENSE)

Plays Spotify for [**upnext-core**](https://www.npmjs.com/package/upnext-core) —
**two backends, with honestly different capabilities.**

```bash
npm i upnext-core upnext-adapter-spotify
```

## Which one you want

| | `SpotifyDesktopAdapter` | `SpotifyWebAdapter` |
|---|---|---|
| **Needs** | the Spotify app, on macOS | an OAuth token + Premium + a live device |
| **Credentials** | none at all | your own, via `getAccessToken` |
| **Search** | ❌ | ✅ |
| **Runs on** | macOS | anywhere Node does |
| **Setup** | none | register an app with Spotify |

The desktop one works right now, on your machine, with nothing to sign up for:

```ts
import { Runtime } from 'upnext-core';
import { SpotifyDesktopAdapter } from 'upnext-adapter-spotify';

const runtime = new Runtime({ adapters: [new SpotifyDesktopAdapter()] });

runtime.enqueue('https://open.spotify.com/track/6f3Slt0GbA2bPZlz0aIFXN');
runtime.enqueue('spotify:track:1OWBh1eVxUdA1Z6UA8r4nh');

await runtime.play();
```

The web one costs setup and buys reach:

```ts
import { SpotifyWebAdapter } from 'upnext-adapter-spotify';

new SpotifyWebAdapter({
  // Your OAuth, your storage, your refresh. This library never runs a flow,
  // holds a client id, or opens a browser.
  getAccessToken: () => myTokenStore.current(),
  deviceId: 'optional-specific-speaker',
});
```

Registering **both** is reasonable. They score the same on a Spotify URI, so the
runtime uses one and falls through to the other when it cannot deliver — the
desktop app while it is open, the Web API when it is not.

## Two adapters, one service, different truths

This is the clearest example in the project of why capabilities belong to an
*adapter* rather than to a *service*:

```ts
{                          // desktop                web
  endOfTrack:      'event',    // 'event'            'event'
  position:        'authoritative',
  externalControl: true,       // ← both: a human shares this backend with you
  seek: true, pause: true, volume: true,
  search:          false,      // ← desktop          true  ← web
}
```

`search: false` is the load-bearing one. Spotify's AppleScript dictionary cannot
search a catalogue. That could be faked — scrape something, guess — and then
every `resolve` of a title would be a coin flip dressed up as a lookup. **An
adapter that says it cannot do a thing is correct and slightly limited; one that
says it can and then does it badly is broken.**

So the desktop adapter scores `0` on anything that is not already a Spotify link,
and the entry goes to a backend that can actually find it.

```ts
runtime.can('search');   // false on desktop, true on web — whichever is loaded
```

## When a human takes over

Spotify is the first backend in this project that somebody else can also touch.
It has its own transport bar, its own queue, and a listener holding a phone who
is entirely entitled to press next.

The hard part is that **"the track I loaded is not the track that is playing"
has two opposite causes**:

```
   our track ended, Spotify rolled on          a person hit next
              │                                       │
              ▼                                       ▼
        advance OUR queue                     the human wins
         (event: ended)                    (event: external → adopted)
```

Get it backwards and the library breaks in the most visible way there is: either
an agent's carefully built queue silently defers to Spotify's autoplay after
every single song, or a listener who picks a song has it yanked away.

What separates them is **where the playhead was on the previous reading**. A
rollover can only happen at the end of a track. The core cannot make that call —
by the time it sees the mismatch, the evidence is gone — so the adapter keeps it.
That decision lives in [`sampler.ts`](./src/sampler.ts) as a pure function, and
every branch of it is a test.

Which way it goes is still the runtime's call, via `desyncPolicy`:

```ts
new Runtime({ desyncPolicy: 'adopt' });   // default — the human wins
new Runtime({ desyncPolicy: 'correct' }); // put our track back
new Runtime({ desyncPolicy: 'ignore' });  // report it, change nothing
```

## What the desktop adapter will never do

**Launch Spotify behind your back.** Reading state is guarded by
`if application "Spotify" is running`, because a bare `tell application` *starts*
the app — and a status poll running every second would boot a music player onto
the machine of someone who never opened one. Only an explicit `play()` may open
it, and it does not steal focus when it does.

**Quit your music player.** Spotify's dictionary has no stop that does not quit,
so `stop()` pauses. The queue moving on to a podcast is not a reason to close
somebody's app.

## Playlists and albums

A container is not a queue entry — this runtime holds one item at a time and owns
the ordering itself. So expanding is explicit, and on purpose: you get to see and
filter the list before it becomes thirty queue entries.

```ts
const tracks = await spotify.expandContext('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
runtime.enqueueMany(tracks.slice(0, 10));
```

## Failures worth telling apart

Every error is a `SpotifyError` with a `reason`, because "your token expired" and
"your phone went to sleep" are both a failed play and an agent that cannot tell
them apart will nag for a login when all it needed to do was wait.

| `reason` | what it means | what to do |
|---|---|---|
| `unauthorized` | no usable session, or macOS Automation was declined | get a token / grant permission |
| `premium-required` | the account cannot control playback | nothing — it's a free account |
| `no-device` | nothing to play *on* | open Spotify somewhere |
| `rate-limited` | too many calls; `retryAfterMs` when Spotify says | wait |
| `not-found` | not in the catalogue, or not in this market | try another source |
| `unavailable` | this backend cannot run here at all | use the other adapter |

A backend that cannot start is reported rather than thrown — it is excluded from
selection and shows up in `getState().adapters` as `available: false` with the
reason. A host on Linux gets one clear message at startup instead of discovering
it one failed track at a time.

## What the Web API needs from you

- **Scopes:** `user-read-playback-state` and `user-modify-playback-state`.
- **Premium.** Every playback-control endpoint is Premium-only. There is nothing
  an adapter can do about that, so a free account gets `premium-required` rather
  than a mystery.
- **Somewhere to play.** The Web API *commands* a device, it is not one. Spotify
  has to be open somewhere, or `deviceId` has to name something real.

## Options

```ts
new SpotifyDesktopAdapter({
  id: 'spotify-desktop',
  sampleIntervalMs: 1000,   // how often to read the app while something plays
  lookup: null,             // turn off the credential-free metadata fill-in
  osascript: myRunner,      // injected for tests
  scheduler: myScheduler,
});

new SpotifyWebAdapter({
  getAccessToken,           // required
  id: 'spotify-web',
  deviceId: '…',
  market: 'US',             // so results are things this listener can play
  sampleIntervalMs: 2000,   // each sample is a real call against a shared limit
  fetch: myFetch,           // injected for tests
});
```

### About `lookup`

The desktop adapter has no catalogue access, so a queue of share links would show
a column of raw URIs until each one started playing. To fill in titles it reads
Spotify's public embed page, which needs no credentials — but **is not a
documented API**, and Spotify can change it whenever it likes.

So it is a nicety, never a dependency: failures are silent, results are cached,
lookups are skipped when the ref already has what it needs, and `lookup: null`
turns it off. Nothing about whether a track *plays* runs through it.

## Testing

Everything is injectable, so all 77 tests run with **no macOS, no Spotify, no
account and no network** — including a captured reading from a real running copy
of the app, kept verbatim so a change to the wire format breaks a test rather
than a user.

## A third door

If you want queue-reading and search with no app registration at all, there is
[spogo](https://github.com/openclaw/spogo), a CLI that presents itself as the
Spotify web player using your browser's cookies. It is deliberately **not** a
dependency here: it works through a rotating secret that Spotify actively
changes, and pinning a published package to that means the treadmill lands on
this issue tracker.

The right home for it is
[`upnext-adapter-process`](https://www.npmjs.com/package/upnext-adapter-process),
which runs an adapter as a subprocess speaking JSON — so the moving target stays
on the far side of a process boundary.

---

Apache-2.0 · [source](https://github.com/tothienbao6a0/upnext/tree/main/packages/adapter-spotify)
