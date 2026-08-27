# upnext-desktop

[![npm](https://img.shields.io/npm/v/upnext-desktop)](https://www.npmjs.com/package/upnext-desktop)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/tothienbao6a0/upnext/blob/main/LICENSE)

**Every audio source this machine can reach, in one call.** Plus a CLI.

```bash
npm i upnext-desktop
```

```ts
import { desktop } from 'upnext-desktop';

const audio = await desktop();

audio.enqueue('spotify:track:1OWBh1eVxUdA1Z6UA8r4nh');
audio.enqueue('https://example.com/podcast.mp3');
audio.enqueue('file:///Users/me/voice-memo.m4a');

await audio.play();
```

That's it. No adapters to choose, no wiring. On a Mac you just got the Spotify
desktop app, the system Now Playing register, and local file playback — none of
which needed a credential.

[`upnext-core`](https://www.npmjs.com/package/upnext-core) asks you to pick and
wire adapters, because a library that guesses is one you can't use when it
guesses wrong. This is the other end of that trade: for someone on a laptop who
just wants audio to work, guessing well *is* the value. Nothing here is
unavailable to you directly — it only saves the wiring.

## The CLI

```bash
npx upnext now            # what's playing, and where
npx upnext pause          # pause it, whatever it is
npx upnext doctor         # what's wired here, and what it can do
npx upnext play <thing>   # play your own queue, in the foreground
```

```
$ upnext now
▶ Korea's STRANGEST Food is on Jeju Island!! — More Best Ever Food Review Show
  Google Chrome · 23:20 / 24:11
```

That's a YouTube tab, read with **no browser extension** — through the system
Now Playing register, MediaRemote on macOS and MPRIS on Linux.

### Two kinds of command, and the difference is real

**Instant** — `now`, `pause`, `resume`, `next`, `prev`. They act on whatever the
machine is already playing and exit immediately. Nothing has to stay alive
because something else owns that playback.

**Foreground** — `play` builds a queue of *its own* and blocks until it
finishes, because a queue this process owns dies with this process.

There is deliberately no `upnext enqueue` adding to a queue some other
invocation is playing. That needs a daemon — a background process holding the
runtime — which is a different program with its own lifecycle. Shipping the
command without one would be exactly the sort of silent failure this project
keeps refusing to ship.

## Titles need something that can search

This is the one thing worth understanding before you start.

```ts
audio.enqueue('spotify:track:1OWBh1eVxUdA1Z6UA8r4nh');  // ✅ always works
audio.enqueue('https://example.com/a.mp3');             // ✅ always works
audio.enqueue({ title: 'Bad Habit' });                  // ⚠️ needs a searcher
```

A link says exactly what to play. A **title** has to be looked up — and not
every backend can look things up. The Spotify *desktop* app can't: its
AppleScript dictionary plays a URI you hand it, but cannot search a catalogue.
So on a default Mac setup, nothing can turn `"Bad Habit"` into something
playable.

`doctor` tells you outright rather than letting you find out:

```
$ upnext doctor
playing through: spotify-desktop, nowplaying, local
titles will NOT resolve: nothing wired here can search. enqueue() a link or a
file path, or pass `library` or `spotifyToken` — or supply `resolveIntent` and
answer it yourself.
```

Three ways to fix it:

```ts
// 1. index a music folder — titles then find local files
await desktop({ library: ['/Users/me/Music'] });

// 2. add a Spotify token — titles then search the catalogue
await desktop({ spotifyToken: async () => myToken });

// 3. answer it yourself — an agent, a database, whatever you like
await desktop({ resolveIntent: async (text) => myModel.pickTrack(text) });
```

## Options

```ts
await desktop({
  library:      ['/Users/me/Music'],   // index folders so titles find local files
  spotifyToken: async () => token,     // Spotify Web: search + play anywhere
  element:      () => new Audio(),     // a media element, in a browser or renderer
  exclude:      ['nowplaying'],        // leave one out by id
  // …plus everything `new Runtime()` takes: resolveIntent, repeat, shuffle, timeoutMs
});
```

## What you get where

| | macOS | Linux | Windows |
|---|:---:|:---:|:---:|
| local files (`ffplay`/`afplay`) | ✅ | ✅ | ✅ |
| Spotify desktop app | ✅ | ❌ | ❌ |
| system Now Playing (browser tabs, VLC, …) | ✅ | with `playerctl` | ❌¹ |
| Spotify Web API | with a token | with a token | with a token |
| a media element | with `element` | with `element` | with `element` |

¹ Windows has an equivalent — SMTC — and the adapter's shape carries over, but
nobody has written it.

Anything unavailable is reported rather than silently missing:
`summariseSetup(runtime).unavailable` gives you the id and the reason.

---

Full docs: **https://github.com/tothienbao6a0/upnext** · Apache-2.0
