# upnext-adapter-local

Plays local and remote audio files for [`upnext-core`](https://www.npmjs.com/package/upnext-core),
by handing them to a command-line player.

```bash
npm i upnext-core upnext-adapter-local
```

```ts
import { Runtime } from 'upnext-core';
import { LocalAdapter } from 'upnext-adapter-local';

const runtime = new Runtime({
  adapters: [new LocalAdapter({ library: ['/Users/me/Music'] })],
});

runtime.enqueue('file:///Users/me/Music/nights.mp3');
runtime.enqueue('https://example.com/episode.mp3');
runtime.enqueue({ title: 'nights' });   // found by title, if a library is indexed

await runtime.play();
```

## Requirements

One of `ffplay` (from ffmpeg) or `afplay` (built into macOS). Nothing else — no
credentials, no accounts, no network.

## Capabilities are discovered, not declared

What this adapter can do depends on which binary is actually installed, so it
reports the truth for the machine it is running on:

| | ffplay | afplay |
| --- | --- | --- |
| `endOfTrack` | `event` | `event` |
| `position` | `estimated` | `estimated` |
| `pause` | yes | yes |
| `seek` | yes | **no** |
| streams `http(s)` | yes | no |

Pause is a real pause rather than a stop-and-restart. Seeking relaunches at an
offset, which only ffplay accepts — so with afplay, `runtime.can('seek')`
correctly returns `false`.

## Options

```ts
new LocalAdapter({
  library: ['/path/to/music'],   // indexed at init so titles can be matched
  players: ['ffplay', 'afplay'], // preference order
  probeDurations: true,          // use ffprobe to fill in durations
});
```

`match` is synchronous by contract, so anything matched by title has to be
indexed up front — that is what `library` is for. Without it, this adapter
handles file paths and audio URLs only.

---

**https://github.com/tothienbao6a0/upnext** · Apache-2.0
