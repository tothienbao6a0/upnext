# upnext-mcp

[![npm](https://img.shields.io/npm/v/upnext-mcp)](https://www.npmjs.com/package/upnext-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/tothienbao6a0/upnext/blob/main/LICENSE)

**An MCP server for your machine's audio.** One queue across Spotify, the
browser, local files, and whatever is already playing.

```json
{
  "mcpServers": {
    "upnext": {
      "command": "npx",
      "args": ["-y", "upnext-mcp", "--library", "/Users/me/Music"]
    }
  }
}
```

Drop that in Claude Desktop, Cursor, Windsurf, or anything else that speaks MCP.

## What it lets an agent do

```
you:  what am I listening to?
      → ❚❚ Acquired — Jensen Huang (Google Chrome)

you:  let that finish, then play Bad Habit
      → adopted "Acquired — Jensen Huang" as q_0001
        up next:
          q_0001  Acquired — Jensen Huang
          q_0002  Bad Habit — Steve Lacy
```

The first line reads a **browser tab** — no extension. The second puts it in the
queue as a real entry, so the agent adds to what someone is doing rather than
cutting across it.

## Tools

| tool | |
|---|---|
| `media_now` | what's playing, in the queue *and* elsewhere on the machine |
| `media_queue` | the queue, with the id of each entry |
| `media_enqueue` | add a link, file path, Spotify URI, or a plain description |
| `media_play` · `media_pause` · `media_next` | transport |
| `media_seek` | jump to a position — says so plainly if the source can't |
| `media_move` · `media_remove` | reorder and drop, by id |
| `media_search` | search the sources that can search |
| `media_adopt_current` | put what's already playing into the queue |
| `media_setup` | what's wired here, and what it can do |

Every mutation is **addressed by id**, and every response includes the queue with
ids in it. That's deliberate: a model working from positions races anything else
touching the queue, and by the time its call lands, position 2 is a different
song.

## It tells the model the truth

Two places where this behaves differently from most tool servers, both for the
same reason — a model that gets a silent no-op will confidently tell the user it
worked.

**`media_seek` on a source that can't seek** returns a sentence, not an error:

> the current source (spotify-desktop) cannot seek. Nothing changed.

**`media_search` with nothing wired to search** explains itself:

> nothing found for "bad habit".
> playing through: spotify-desktop, nowplaying, local
> titles will NOT resolve: nothing wired here can search…

## Titles need a searcher

A link says exactly what to play. A *description* has to be looked up, and not
every backend can. The Spotify desktop app plays a URI you hand it but cannot
search a catalogue — so on a plain Mac setup, `media_enqueue` with `"bad habit"`
has nothing to resolve against.

Give it one of these:

```jsonc
// index a music folder
"args": ["-y", "upnext-mcp", "--library", "/Users/me/Music"]

// or a Spotify Web token, via the environment
"env": { "SPOTIFY_TOKEN": "..." }
```

`media_setup` will tell you which you have.

## Embedding it instead

If your product already has a queue, expose *that* one rather than starting a
second that competes with it:

```ts
import { createServer } from 'upnext-mcp';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

serveStdio(() => createServer(myExistingRuntime));
```

This package is a **transport, and nothing more** — ordering, capability
negotiation, resolution and reconciliation all happen in
[`upnext-core`](https://www.npmjs.com/package/upnext-core). It lives apart
because a transport is an opinion, and nobody importing the runtime should
inherit this one.

---

Full docs: **https://github.com/tothienbao6a0/upnext** · Apache-2.0
