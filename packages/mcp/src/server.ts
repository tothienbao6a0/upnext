#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { desktop } from 'upnext-desktop';
import { createServer } from './index.js';

/**
 * The installable server: wires every source this machine can reach, then
 * exposes it over stdio.
 *
 * `--library <dir>` is worth passing. Without it — or a Spotify token — nothing
 * here can turn a plain description into something playable, and `media_setup`
 * will say so rather than letting the model guess why enqueue did nothing.
 */
const library: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--library' && argv[i + 1]) library.push(argv[++i]!);
}

const runtime = await desktop({
  library,
  ...(process.env.SPOTIFY_TOKEN
    ? { spotifyToken: async () => process.env.SPOTIFY_TOKEN! }
    : {}),
});

serveStdio(() => createServer(runtime));
