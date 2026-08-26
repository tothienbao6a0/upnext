# upnext-adapter-nowplaying

[![npm](https://img.shields.io/npm/v/upnext-adapter-nowplaying)](https://www.npmjs.com/package/upnext-adapter-nowplaying)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/tothienbao6a0/upnext/blob/main/LICENSE)

**Read and control whatever your Mac is playing — including a browser tab —
without an extension.**

macOS keeps a system-wide Now Playing register: the thing Control Center shows,
and the thing your keyboard's play/pause key talks to. Anything that publishes
to it is reachable — a YouTube tab in Chrome, a podcast in Safari, VLC, Doppler,
Music, Spotify.

```ts
import { readNowPlaying, sendTransport } from 'upnext-adapter-nowplaying';

await readNowPlaying();
// { bundleId: 'com.google.Chrome', label: 'Google Chrome', playing: true,
//   title: 'Acquired — Jensen Huang', artist: 'YouTube',
//   elapsedMs: 60000, durationMs: 3600000 }

await sendTransport('pause');   // pauses it, whatever it is
```

That works with no browser extension, no accessibility permission, and no
per-site integration.

## As a queue entry

The interesting use isn't observation — it's **not interrupting people**.

```ts
import { Runtime } from 'upnext-core';
import { NowPlayingAdapter, NOW_PLAYING_URI } from 'upnext-adapter-nowplaying';

const runtime = new Runtime({ adapters: [new NowPlayingAdapter(), ...others] });

runtime.enqueue(NOW_PLAYING_URI);                 // let their podcast finish
runtime.enqueue({ title: 'Bad Habit' });          // then take over

await runtime.play();
```

An agent adding to someone's listening instead of cutting across it. When their
episode ends, the queue moves on by itself.

And if they skip to something else in that tab, the runtime notices and adopts
it — their choice wins, which is the default everywhere in upnext.

## What it can and cannot do

This adapter answers to exactly one entry, `nowplaying:current`, meaning *the
thing that is on*. It cannot be handed a track, because there is no way to ask
the register to start one — so it scores zero for every other locator rather
than claiming it could.

```ts
{
  endOfTrack:      'poll',           // the register does not notify; we sample it
  position:        'authoritative',  // elapsed comes from the player itself
  pause:           true,
  seek:            false,            // the bridge cannot pass seek options cleanly
  volume:          false,            // the register exposes no volume
  search:          false,
  externalControl: true,             // the strongest case in the library
}
```

`externalControl` has never meant more than it does here. The runtime is a
guest: the item was chosen by somebody else, in an app it does not control, and
it can change underneath at any moment.

`stop()` pauses rather than quitting. The queue moving on is not a reason to
take somebody's podcast away from them.

## How it works, and the honest caveats

It reaches `MediaRemote`, a **private Apple framework**, through JXA's
Objective-C bridge. Private API is normally a bad trade, so:

- **There is no public equivalent.** `MPNowPlayingInfoCenter` publishes *your
  own* app's state. Nothing public reads another app's.
- **Apple began gating MediaRemote behind an entitlement in macOS 15.4**, which
  broke the usual command-line tools. The gate applies to processes asking
  directly; script execution through `osascript` still resolves it. Verified
  working on **macOS 26.5.2**.
- **The alternative is worse.** Shipping a helper binary that borrows a system
  binary's entitlements is a far larger and more fragile dependency than a
  script you can read in full — and you can: it's in
  [`src/mediaremote.ts`](./src/mediaremote.ts), about forty lines.
- **Every failure answers null.** The day Apple closes this, the adapter reports
  itself unavailable, the registry excludes it, and the rest of your queue
  carries on.

**macOS only.** On any other platform `init()` fails cleanly and
`getState().adapters` shows `available: false` with the reason.

### It filters out things that aren't media

macOS's now-playing client is *whatever last made a sound*. A received voice
message leaves Messages sitting there as the now-playing app, with no title and
a seven-second "track". Requiring a title and a real duration is what separates
*something is playing* from *something made a noise once*.

## Compared with the other adapters

| | starts tracks | who chose it | can be changed under you |
|---|:---:|---|:---:|
| `upnext-adapter-local` | ✅ | you | no |
| `upnext-adapter-browser` | ✅ | you | no |
| `upnext-adapter-spotify` | ✅ | you, mostly | **yes** |
| **`upnext-adapter-nowplaying`** | ❌ | **somebody else** | **yes** |

This is the far end of the capability spectrum the whole library is built
around — and a useful proof that the contract stretches that far without
bending.

---

Full docs: **https://github.com/tothienbao6a0/upnext** · Apache-2.0
