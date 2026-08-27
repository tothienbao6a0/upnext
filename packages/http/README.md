# upnext-http

[![npm](https://img.shields.io/npm/v/upnext-http)](https://www.npmjs.com/package/upnext-http)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/tothienbao6a0/upnext/blob/main/LICENSE)

Control an [upnext](https://www.npmjs.com/package/upnext-core) queue over HTTP,
with a live event stream. **Zero dependencies, loopback by default.**

```ts
import { serveHttp } from 'upnext-http';
import { desktop } from 'upnext-desktop';

const runtime = await desktop();
const server = await serveHttp({ runtime, port: 8791 });
console.log(server.url);   // http://127.0.0.1:8791
```

```bash
curl localhost:8791/state
curl -X POST localhost:8791/queue -d '{"item":"spotify:track:1OWBh1eVxUdA1Z6UA8r4nh"}'
curl -X POST localhost:8791/play
curl -N localhost:8791/events      # live stream
```

## Routes

| | |
|---|---|
| `GET /health` | liveness. The one route a token does not gate. |
| `GET /state` | the full snapshot: playback, queue, adapters |
| `GET /queue` · `POST /queue` | read, or add `{ item, position? }` |
| `DELETE /queue/:id` | remove |
| `POST /queue/:id/move` | reorder — `{ after? }`, or next when omitted |
| `POST /play` · `/pause` · `/resume` · `/next` · `/previous` · `/stop` | transport |
| `POST /seek` · `/volume` | `{ ms }` / `{ level }` |
| `GET /events` | server-sent events |

Entries are addressed by **id**, never by position — the same reason the library
itself is: by the time a request lands, position 2 may be a different song.

## It answers rather than failing

A backend that cannot seek returns **409 with a reason**, not a 500:

```json
{ "error": "the current source cannot seek", "adapterId": "spotify-desktop" }
```

Bad input is a 400. An unknown id is a 404. A client should never have to read a
stack trace to find out its request was simply not possible here.

## Events

`GET /events` opens an SSE stream carrying every runtime event —
`queue:changed`, `playback:changed`, `position`, `item:started`, `desync`, and
the rest.

It **opens with the current state**, so a client that connects mid-track knows
what is playing without waiting for something to change.

```
event: state
data: {"version":3,"playback":{...},"queue":[...]}

event: item:started
data: {"item":{...}}
```

## Security

The default is `127.0.0.1`, and that is deliberate. This endpoint can read what
somebody is listening to and take over their speakers — so reaching past this
machine is an explicit act:

```ts
await serveHttp({ runtime, host: '0.0.0.0', token: process.env.TOKEN });
```

Binding to anything but loopback **without a token throws at startup** rather
than quietly opening a port. Tokens are compared at full length so a rejection
tells an attacker nothing, and request bodies are capped — a queue command is a
few hundred bytes, and anything larger is a mistake or an attempt to exhaust
memory.

---

Full docs: **https://github.com/tothienbao6a0/upnext** · Apache-2.0
