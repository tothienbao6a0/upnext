# upnext-adapter-browser

[![npm](https://img.shields.io/npm/v/upnext-adapter-browser)](https://www.npmjs.com/package/upnext-adapter-browser)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/tothienbao6a0/upnext/blob/main/LICENSE)

Plays audio through a media element you control, for
[**upnext-core**](https://www.npmjs.com/package/upnext-core) — in a browser, an
Electron renderer, or a webview.

`upnext-core` has always claimed it runs anywhere JavaScript does. Until this
package, the only adapter that could make a sound shelled out to `ffplay`, so a
browser had a queue and no way to play it. This closes that.

## Install

```bash
npm i upnext-core upnext-adapter-browser
```

```ts
import { Runtime } from 'upnext-core';
import { MediaElementAdapter } from 'upnext-adapter-browser';

const runtime = new Runtime({
  adapters: [new MediaElementAdapter({ element: document.querySelector('audio')! })],
});

runtime.enqueue('https://traffic.megaphone.fm/episode.mp3');
runtime.enqueue('https://example.com/track.m4a');
await runtime.play();
```

The element can be a function, so a host can build its queue before it has a
document:

```ts
new MediaElementAdapter({ element: () => new Audio() });
```

## What it plays — and what it refuses

An `<audio>` element plays a **media stream**. It does not play a **page**. That
distinction is the whole design of this adapter, because "the browser can play
anything" is the intuition and it is wrong.

| | score | |
|---|:---:|---|
| `https://…/episode.mp3` | **1** | a direct stream |
| `https://…/ABC.mp3?updated=1712` | **1** | query strings don't hide the format |
| `blob:` / `data:audio/…` | **1** | already bytes |
| `file:///music/song.mp3` | 0.8 | Electron and webviews yes, plain web no |
| `https://…/download/12345` | 0.2 | no extension — podcast enclosures look like this, so it's tried last |
| `https://…/article.html` | **0** | names a format we can't decode |
| **`youtube.com/watch?v=…`** | **0** | **a page, not a stream** |
| `open.spotify.com/track/…` | **0** | a page — use `upnext-adapter-spotify` |
| `soundcloud.com`, `bandcamp.com`, `vimeo.com`, … | **0** | pages |

Those refusals are deliberate and explicit. Handing an element a YouTube watch
URL gets you a lump of HTML and a decode error — and a queue full of things that
fail at the last moment is worse than one that admitted up front it couldn't
take them. Scoring zero sends the entry to another adapter, or fails it
honestly.

Making those work needs a page-level integration — YouTube's IFrame player, a
SoundCloud widget, a stream extractor — which is a different adapter with
different terms of service, not a cleverer regex here.

If your element has been taught extra formats (hls.js, a custom source
extension), say so:

```ts
new MediaElementAdapter({ element, extraExtensions: ['.dsf'] });
```

## It does not touch tabs you already have open

This adapter **owns a player**. It does not reach into pages the user has open.

Commandeering somebody's YouTube tab needs a browser extension, and it's a
different feature with a different risk profile — *pausing whatever is playing*
is a control feature, where *queueing* needs a player you can hand things to.
You cannot queue into a stranger's tab.

## Capabilities

```ts
{
  endOfTrack:      'event',          // the element's `ended` — no polling, no timers
  position:        'authoritative',  // currentTime, not a guess
  seek: true, pause: true, volume: true,
  search:          false,            // it plays a URL it is handed
  externalControl: false,            // nobody else has a handle on this element
}
```

This is the fully-controlled end of the capability spectrum — the opposite of
`upnext-adapter-spotify`, where a human can hit next on their phone.

Blocked autoplay is reported as a failure rather than swallowed, so the runtime
falls through to a source that can actually make sound.

## Gapless

Give it a second element and the next track is buffered while the current one is
still playing, so the switch at the end is instant rather than a fetch:

```ts
new MediaElementAdapter({
  element: () => new Audio(),
  spare:   () => new Audio(),   // the next track loads in here
});
```

One element cannot do this — setting `src` stops what is playing. With two, the
idle one loads ahead and the pair swap over at the end.

Without `spare` the adapter works exactly as before and declares
`preload: false`, because a capability it cannot honour is worse than one it
lacks. The runtime reads that flag and simply does not offer it anything early.

## Across a process boundary

In Electron the queue usually lives in the main process, and only a renderer can
hold an `<audio>`. The adapter splits in two, over any transport you like:

```ts
// main process — where the Runtime is
import { RemoteMediaAdapter } from 'upnext-adapter-browser';

const runtime = new Runtime({
  adapters: [new RemoteMediaAdapter({
    channel: {
      send: (m) => win.webContents.send('upnext', m),
      subscribe: (fn) => {
        const h = (_e, m) => fn(m);
        ipcMain.on('upnext', h);
        return () => ipcMain.off('upnext', h);
      },
    },
  })],
});
```

```ts
// renderer — where the element is
import { serveMediaElement } from 'upnext-adapter-browser';

serveMediaElement(document.querySelector('audio')!, {
  send: (m) => ipcRenderer.send('upnext', m),
  subscribe: (fn) => {
    const h = (_e, m) => fn(m);
    ipcRenderer.on('upnext', h);
    return () => ipcRenderer.off('upnext', h);
  },
});
```

The transport is deliberately unnamed — `ipcMain`/`ipcRenderer`, `postMessage`,
a WebSocket, or two functions in a test. This package takes a `Channel` and asks
no further questions.

`serveMediaElement` drives a real `MediaElementAdapter`, so behaviour on the far
side is the same class as the in-process case and cannot drift from it. `match`
is evaluated locally and never crosses the wire — it's synchronous by contract,
and what an element accepts is knowable from the URL. Requests are bounded by
`requestTimeoutMs` (5s default), and a malformed command becomes an error reply
rather than an exception thrown inside a renderer where nothing is listening.

---

Full docs: **https://github.com/tothienbao6a0/upnext** · Apache-2.0
