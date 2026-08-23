# upnext-adapter-local

[![npm](https://img.shields.io/npm/v/upnext-adapter-local)](https://www.npmjs.com/package/upnext-adapter-local)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/tothienbao6a0/upnext/blob/main/LICENSE)

Plays local files and audio streams for
[**upnext-core**](https://www.npmjs.com/package/upnext-core), by handing them to a
command-line player.

**The reference backend: no credentials, no accounts, no network.** It's what
makes upnext demonstrable with nothing installed.

## Install

```bash
npm i upnext-core upnext-adapter-local
```

Needs one of **`ffplay`** (from ffmpeg) or **`afplay`** (built into macOS).

```ts
import { Runtime } from 'upnext-core';
import { LocalAdapter } from 'upnext-adapter-local';

const runtime = new Runtime({
  adapters: [new LocalAdapter({ library: ['/Users/me/Music'] })],
});

runtime.enqueue('file:///Users/me/Music/nights.mp3');   // a path
runtime.enqueue('https://example.com/episode.mp3');     // a stream (ffplay only)
runtime.enqueue({ title: 'nights' });                   // by title, if indexed

await runtime.play();
```

## Capabilities are discovered, not declared

What this adapter can do depends on **which binary is actually installed**, so it
reports the truth for the machine it's running on:

|                   | `ffplay` | `afplay` |
|-------------------|:--------:|:--------:|
| `endOfTrack`      | `event`  | `event`  |
| `position`        | `estimated` | `estimated` |
| `pause`           | ✅       | ✅       |
| `seek`            | ✅       | ❌       |
| `http(s)` streams | ✅       | ❌       |

```ts
runtime.can('seek');   // true with ffplay, false with afplay — honestly
```

Pause is a **real pause** (`SIGSTOP`), not a stop-and-restart. Seeking relaunches
at an offset, which only ffplay accepts — so with afplay, `seek` correctly
reports `false` and throws rather than silently doing nothing.

This adapter sits at the fully-controlled end of the capability spectrum: the
player process is ours, so **its exit *is* the end-of-track event** — no polling,
no guessing.

## Options

```ts
new LocalAdapter({
  library: ['/path/to/music'],   // scanned at init so titles can be matched
  players: ['ffplay', 'afplay'], // preference order
  probeDurations: true,          // use ffprobe to fill in durations
});
```

`match` is synchronous by contract — the runtime calls it on every resolution and
can't hit the filesystem — so anything matched **by title** has to be indexed up
front. That's what `library` is for. Without it, this adapter handles file paths
and audio URLs only.

## Supported files

`.mp3` `.m4a` `.aac` `.wav` `.aiff` `.flac` `.ogg` `.opus` `.wma`

---

Full docs: **https://github.com/tothienbao6a0/upnext** · Apache-2.0
