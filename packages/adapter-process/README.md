# upnext-adapter-process

Run an [`upnext-core`](https://www.npmjs.com/package/upnext-core) adapter as a
subprocess, so a backend can be written in any language.

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

From the runtime's side this is an ordinary adapter — it has capabilities, it
resolves, it plays, it pushes events. The pipe is an implementation detail.

## The protocol

One JSON object per line, both directions. No framing headers, no schema
registry, no code generation.

```
→  {"id": 1, "method": "init"}
←  {"id": 1, "result": {"capabilities": {...}, "schemes": ["spotify:"]}}

→  {"id": 2, "method": "resolve", "params": {"ref": {"title": "Nights"}}}
←  {"id": 2, "result": {"adapterId": "python", "nativeUri": "...", "ref": {...}}}

→  {"id": 3, "method": "load", "params": {"binding": {...}}}
→  {"id": 4, "method": "play"}
←  {"event": {"type": "ended"}}
```

Methods: `init`, `resolve`, `search`, `load`, `play`, `pause`, `stop`, `seek`,
`setVolume`, `poll`. Implement only what your capabilities claim.

**`match` is evaluated on the host side.** The in-process contract requires it
to be synchronous, which is impossible across a pipe, so your child declares its
claims once at `init` — which URI schemes it handles, whether it can attempt
title-only refs — and the host applies them locally.

## A complete example

[`examples/python-adapter/adapter.py`](https://github.com/tothienbao6a0/upnext/blob/main/packages/adapter-process/examples/python-adapter/adapter.py)
is a working backend in about 150 lines of Python, covered by the test suite.
The runtime cannot tell it apart from a native one.

Most of the people who can write a good Spotify or Apple Music backend are not
going to write it in TypeScript, and the adapter ecosystem is the point.

## Safety

The child is a command **you** configure — this package does not fetch or choose
it. Requests are bounded by `requestTimeoutMs` (10s default), a child that dies
rejects everything outstanding rather than hanging, and unparseable output is
reported rather than crashing playback.

---

**https://github.com/tothienbao6a0/upnext** · Apache-2.0
