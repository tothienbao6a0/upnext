# upnext-adapter-process

[![npm](https://img.shields.io/npm/v/upnext-adapter-process)](https://www.npmjs.com/package/upnext-adapter-process)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/tothienbao6a0/upnext/blob/main/LICENSE)

**Write an [upnext](https://www.npmjs.com/package/upnext-core) adapter in any
language.** Your backend runs as a subprocess and speaks one JSON object per
line; from the runtime's side it's an ordinary adapter and the pipe is an
implementation detail.

Most of the people who can write a good Spotify or Apple Music backend aren't
going to write it in TypeScript — and the adapter ecosystem is the whole point.

## Install

```bash
npm i upnext-core upnext-adapter-process
```

```ts
import { Runtime } from 'upnext-core';
import { ProcessAdapter } from 'upnext-adapter-process';

const runtime = new Runtime({
  adapters: [
    new ProcessAdapter({
      id: 'python',
      command: 'python3',
      args: ['./my-adapter.py'],
    }),
  ],
});
```

## The protocol

```
   host                                  your child process
   ────                                  ──────────────────
   → {"id":1,"method":"init"}
                              ← {"id":1,"result":{"capabilities":{…},
                                                  "schemes":["spotify:"]}}

   → {"id":2,"method":"resolve",
      "params":{"ref":{"title":"Nights"}}}
                              ← {"id":2,"result":{"adapterId":"python",
                                                  "nativeUri":"…","ref":{…}}}

   → {"id":3,"method":"load","params":{"binding":{…}}}
   → {"id":4,"method":"play"}

                              ← {"event":{"type":"ended"}}   ← unsolicited
```

One JSON object per line, both directions. **No framing headers, no schema
registry, no code generation.**

**Methods** — implement only what your capabilities claim:

| method | required? |
|---|---|
| `init` | yes — returns your capabilities and claims |
| `resolve`, `load`, `play`, `stop` | yes |
| `pause`, `seek`, `setVolume` | only if you declare the matching capability |
| `poll` | only if `endOfTrack: 'poll'` or `position: 'authoritative'` |
| `search` | only if `search: true` |

**Events** you can push at any time: `ended`, `position`, `status`, `external`,
`error`.

### `match` runs on the host side

The in-process contract requires `match` to be **synchronous** — the runtime
calls it on every resolution — which is impossible across a pipe. So your child
declares its claims once at `init` and the host evaluates them locally:

```json
{
  "capabilities": { "endOfTrack": "event", "pause": true },
  "schemes": ["spotify:", "https://open.spotify.com/"],
  "schemeScore": 1,
  "matchesTitles": true,
  "titleScore": 0.4
}
```

## A complete working example

[`examples/python-adapter/adapter.py`](https://github.com/tothienbao6a0/upnext/blob/main/packages/adapter-process/examples/python-adapter/adapter.py)
is a real backend in ~150 lines of Python — it ships inside this package, and
it's covered by the test suite. **The runtime cannot tell it apart from a native
adapter.**

It ships inside the installed package, so you can point straight at it:

```ts
new ProcessAdapter({
  id: 'python',
  command: 'python3',
  args: ['node_modules/upnext-adapter-process/examples/python-adapter/adapter.py'],
});
```

## Safety

The child is a command **you** configure — this package never fetches or chooses
one.

- Requests are bounded by `requestTimeoutMs` (10s default)
- A child that dies rejects everything outstanding rather than hanging
- Unparseable output on stdout is reported, not fatal
- `init` is idempotent, so registering with a `Runtime` can't spawn twice

---

Full docs: **https://github.com/tothienbao6a0/upnext** · Apache-2.0
