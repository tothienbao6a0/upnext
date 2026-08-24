# Contributing

The most valuable thing you can contribute is an **adapter**. The core is
deliberately small and mostly finished; what makes this useful to anyone is the
number of places it can send audio.

## Getting set up

```bash
npm install
npm test        # 192 tests, runs in under a second
npm run demo    # plays actual audio, needs ffplay or afplay
```

Everything builds with `tsc` and tests with `node:test`. There is no bundler, no
test framework and no lint step to install — the toolchain is deliberately
nothing you have to adopt.

## Writing an adapter

Start from whichever existing one is closest to your backend:

| | |
|---|---|
| `packages/adapter-local` | you fully own the player — a process, an `<audio>` element |
| `packages/adapter-spotify` | somebody else's app that a human can also touch |
| `packages/adapter-process/examples/python-adapter/adapter.py` | you would rather not write TypeScript |

Adapters do not have to live in this repo, and they do not have to be in this
language.

Required: `id`, `capabilities`, `match`, `resolve`, `load`, `play`, `stop`.
Everything else is optional and gated by what you declare.

**Declare capabilities honestly.** They are promises about behaviour, and the
runtime changes what it does based on them — `endOfTrack: 'event'` means it will
wait for you to say so and will never poll. `addAdapter` rejects an adapter that
claims something it has no method to deliver, but it cannot catch a claim that
is merely optimistic. When in doubt, declare the weaker thing: a backend that
says it cannot seek is correct and slightly limited, one that says it can and
then does not is broken.

**`match` must be synchronous and cheap.** It runs on every resolution. If your
adapter needs to look something up to know whether it can help, build the index
in `init` — see `packages/adapter-local/src/library.ts`.

**If a human can also touch your backend, say so.** `externalControl: true`
means the runtime reconciles rather than assuming it is the only writer. It also
means you own a decision the core cannot make: when the backend is suddenly
playing something else, only you know whether your track just *ended* and the
backend rolled on, or whether a person chose something. Answering that wrongly
either makes the queue defer to autoplay after every song or overrules the
listener. `packages/adapter-spotify/src/sampler.ts` is a worked example, kept
pure so every branch of it is a plain test.

**Return `null` from `resolve` rather than guessing.** The runtime will try the
next source, which is almost always better than confidently playing the wrong
song. It also verifies what you return against what was asked for, so a bad
guess is likely to be rejected anyway.

## Changes to the core

Please open an issue first. The core is a contract other people's adapters
depend on, so the bar for changing its shape is high, and there is usually a way
to do what you need through the existing surface. If there is not, that is worth
knowing about — it means the API is missing something.

Anything in `upnext-core/internal` is unsupported and will move.

## Tests

Every behavioural change needs a test. `ManualScheduler` lets you step time by
hand, so tests of timing are exact rather than slept-through, and `FakeAdapter`
lets you configure a backend anywhere on the capability spectrum:

```ts
new FakeAdapter({ capabilities: { endOfTrack: 'poll', position: 'authoritative' } });
```

**Tests must not need your backend installed.** Inject whatever reaches the
outside world — `adapter-spotify` takes its `osascript` and its `fetch` as
options for exactly this reason, so its whole suite runs on Linux with no
Spotify, no account and no network. CI has none of those things, and a test that
only passes on your laptop is not protecting anyone.

If you are fixing a bug, add the failing test first. Three of the bugs in this
codebase were found by running `npm run demo` and listening, not by reading
code — if you are touching playback, run it and listen.

## Commits and PRs

Small commits grouped by what they change, present tense, explaining *why*
rather than restating the diff. CI runs build, tests and the demo on Node 20 and
22 across Linux and macOS; all of it has to pass.
