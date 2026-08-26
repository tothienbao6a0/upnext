# upnext-adapter-apple-music

[![npm](https://img.shields.io/npm/v/upnext-adapter-apple-music)](https://www.npmjs.com/package/upnext-adapter-apple-music)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/tothienbao6a0/upnext/blob/main/LICENSE)

Plays your Apple Music library through the **Music app on macOS**, for
[upnext-core](https://www.npmjs.com/package/upnext-core).

**It can search.** That is why this exists rather than being a second copy of the
Spotify adapter — and it makes this the first source that resolves a plain title
with no credentials, no account registration, and nothing to install beyond an
app that ships with the system.

```ts
import { Runtime } from 'upnext-core';
import { AppleMusicAdapter } from 'upnext-adapter-apple-music';

const runtime = new Runtime({ adapters: [new AppleMusicAdapter()] });

runtime.enqueue({ title: 'Bad Habit', artist: 'Steve Lacy' });   // ← no link needed
await runtime.play();
```

## Why searching matters here

Every other zero-credential source can only play something you already have a
link for:

| | plays a link | resolves a plain title |
|---|:---:|:---:|
| Spotify desktop app | ✅ | ❌ — its dictionary cannot search |
| a media element | ✅ | ❌ — needs a URL |
| local files | ✅ | only with a folder you indexed |
| system Now Playing | ❌ | ❌ — cannot start anything |
| **Music app** | ✅ | **✅** |

So on a plain Mac, this is what turns `"Bad Habit"` into something that plays.

It searches your **library**, not the catalogue — what it can play is what you
actually have. A hit that merely shares a word is refused rather than played:
resolution is scored, and anything below the threshold falls through to another
source instead of confidently playing the wrong song.

## Capabilities

```ts
{
  endOfTrack:      'poll',           // the app does not notify; the runtime samples it
  position:        'authoritative',  // the app's own playhead
  search:          true,             // ← the differentiator
  seek: true, pause: true, volume: true,
  externalControl: true,             // somebody can hit next in the app, or on their keyboard
}
```

## What it will not do

**It never launches the Music app.** Every script is wrapped in
`if application "Music" is running`. A bare `tell application "Music"` *starts*
it, and a status poll that opens a music player on somebody's machine is not a
status poll. When it is not running, reads answer nothing.

**`stop()` pauses rather than quitting.** The queue moving on to a podcast is not
a reason to close somebody's music app.

**macOS only.** `init()` fails cleanly elsewhere and the registry reports
`available: false` with the reason.

## Notes from building it

Two things worth writing down, since both cost time:

- **`st` is a reserved token** in Music's AppleScript dictionary. `set st to
  (player state as text)` is a syntax error; `set theState to …` is fine.
- **Fields come back separated by ASCII 31**, the unit separator, not a pipe or
  a tab. Real track titles contain every printable delimiter anyone would
  otherwise reach for.

---

Full docs: **https://github.com/tothienbao6a0/upnext** · Apache-2.0
