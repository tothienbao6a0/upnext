#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readNowPlaying, sendTransport } from 'upnext-adapter-nowplaying';
import { desktop, explainSetup } from './index.js';

/**
 * A command line for the machine's audio.
 *
 * Two kinds of command, and the difference is worth stating plainly rather than
 * hiding, because it is a real constraint rather than an oversight:
 *
 *   - **Instant** commands (`now`, `pause`, `next`, …) work on whatever the
 *     machine is already playing, through the system Now Playing register. They
 *     run and exit. Nothing needs to stay alive because something else owns the
 *     playback.
 *
 *   - **`play`** builds a queue of your own and plays it in the foreground. It
 *     blocks until the queue ends or you interrupt it, because a queue this
 *     process owns dies with this process.
 *
 * Adding to a queue that another invocation is playing would need a daemon — a
 * background process holding the runtime, with these commands talking to it.
 * That is a real design, and it is deliberately not here: it is a different
 * program with its own lifecycle, and pretending `upnext enqueue` works without
 * one would be the kind of silent failure this project keeps refusing to ship.
 */

/**
 * Read rather than written down. The MCP server hardcoded its version and
 * spent three releases introducing itself as 0.1.0, which is a mistake worth
 * making once.
 *
 * Two levels up, because this runs compiled from dist/src/.
 */
const VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

const HELP = `upnext — one queue over every audio source

  Instant (act on whatever the machine is playing, then exit)
    upnext now                    what is playing, and where
    upnext pause | resume         transport
    upnext next | prev            skip
    upnext doctor                 what is wired here, and what can resolve titles

  Foreground (owns its own queue, blocks until finished)
    upnext play <thing> [more…]   play these, in order

  A <thing> is a link, a file path, or a Spotify URI. A bare title works only
  when something can search — run \`upnext doctor\` to find out.

  Options
    --library <dir>   index a folder so titles can find local files (repeatable)
    --version         print the version and exit
`;

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const library: string[] = [];
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === '--library' && args[i + 1]) {
      library.push(args[i + 1]!);
      args.splice(i, 2);
    }
  }

  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case '-v':
    case '--version':
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;

    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return 0;

    case 'now': {
      const reading = await readNowPlaying();
      if (!reading) {
        process.stdout.write('nothing playing\n');
        return 1;
      }
      const mark = reading.playing ? '▶' : '❚❚';
      const where = reading.label || reading.bundleId;
      process.stdout.write(
        `${mark} ${reading.title}${reading.artist ? ` — ${reading.artist}` : ''}\n` +
          `  ${where} · ${clock(reading.elapsedMs)} / ${clock(reading.durationMs)}\n`,
      );
      return 0;
    }

    case 'pause':
    case 'resume':
    case 'next':
    case 'prev': {
      const mapped = command === 'resume' ? 'play' : command === 'prev' ? 'previous' : command;
      const ok = await sendTransport(mapped as 'play' | 'pause' | 'next' | 'previous');
      if (!ok) {
        process.stderr.write('nothing responded — is anything playing?\n');
        return 1;
      }
      return 0;
    }

    case 'doctor': {
      const runtime = await desktop({ library });
      process.stdout.write(`${explainSetup(runtime)}\n`);
      await runtime.dispose();
      return 0;
    }

    case 'play': {
      if (rest.length === 0) {
        process.stderr.write('nothing to play. `upnext play <thing>`\n');
        return 1;
      }
      const runtime = await desktop({ library });

      runtime.on('item:started', ({ item }) =>
        process.stdout.write(`▶ ${item.ref.title ?? item.ref.uri}\n`),
      );
      runtime.on('item:failed', ({ item, error }) =>
        process.stderr.write(`✗ ${item.ref.title ?? item.ref.uri ?? item.intent}: ${error.message}\n`),
      );

      runtime.enqueueMany(rest);
      await runtime.play();

      // A queue this process owns dies with this process, so wait it out.
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        runtime.on('playback:changed', (state) => {
          if (state.status === 'ended' || state.status === 'idle') done();
        });
        process.once('SIGINT', done);
      });

      await runtime.dispose();
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
