import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Runtime } from 'upnext-core';
import { explainSetup, readNowPlaying, NOW_PLAYING_URI } from 'upnext-desktop';

/**
 * upnext as a set of tools an agent can call.
 *
 * A thin transport, deliberately. Everything interesting — ordering, capability
 * negotiation, resolution, reconciliation — already happened in the runtime; the
 * job here is only to describe it in the vocabulary MCP speaks and to hand back
 * text a model can act on.
 *
 * Which is why this lives in its own package. A transport is an opinion, and
 * nobody importing `upnext-core` should inherit this one.
 */

/** What a tool hands back. Text, because that is what a model reads. */
function say(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function describeQueue(runtime: Runtime): string {
  const { playback, queue } = runtime.getState();
  const lines: string[] = [];

  const now = runtime.nowPlaying();
  if (now) {
    const clock = playback.durationMs
      ? ` ${fmt(playback.positionMs)}/${fmt(playback.durationMs)}`
      : '';
    lines.push(`${playback.status === 'playing' ? '▶' : '❚❚'} ${label(now.ref, now.intent)}${clock}  [${playback.adapterId}]`);
  } else {
    lines.push(`${playback.status} — nothing loaded`);
  }

  const upcoming = queue.filter(
    (item) => item.status === 'pending' || item.status === 'unresolved' || item.status === 'ready',
  );
  if (upcoming.length === 0) lines.push('up next: (empty)');
  else {
    lines.push('up next:');
    // Ids are included because every mutation is addressed by id — a model that
    // wants to move or remove something needs the handle, not the position.
    for (const item of upcoming) lines.push(`  ${item.id}  ${label(item.ref, item.intent)}`);
  }

  return lines.join('\n');
}

function label(ref: { title?: string; artist?: string; uri?: string }, intent?: string): string {
  if (ref.title) return ref.artist ? `${ref.title} — ${ref.artist}` : ref.title;
  return ref.uri ?? (intent ? `“${intent}”` : 'unknown');
}

function fmt(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Build the server around an existing runtime.
 *
 * Takes a `Runtime` rather than building one, so a host that already has audio
 * wired can expose *that* queue rather than a second one competing with it.
 */
export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: 'upnext', version: '0.1.0' });

  server.registerTool(
    'media_now',
    {
      description:
        'What is playing right now — including audio this machine is playing outside the queue, such as a browser tab.',
      inputSchema: z.object({}),
    },
    async () => {
      const outside = await readNowPlaying();
      const mine = describeQueue(runtime);
      if (!outside) return say(mine);
      return say(
        `${mine}\n\nelsewhere on this machine: ${outside.playing ? '▶' : '❚❚'} ` +
          `${outside.title}${outside.artist ? ` — ${outside.artist}` : ''} (${outside.label})`,
      );
    },
  );

  server.registerTool(
    'media_queue',
    { description: 'Show the queue, with the id of each entry.', inputSchema: z.object({}) },
    async () => say(describeQueue(runtime)),
  );

  server.registerTool(
    'media_enqueue',
    {
      description:
        'Add something to the queue. Accepts a link, a file path, a Spotify URI, or a plain description ' +
        'to be resolved later. Use position to play it next rather than last.',
      inputSchema: z.object({
        item: z.string().describe('A link, a file path, a spotify: URI, or a description'),
        position: z.enum(['next', 'end']).optional(),
      }),
    },
    async ({ item, position }) => {
      const entry = runtime.enqueue(item, position === 'next' ? { next: true } : {});
      return say(`queued ${entry.id}: ${label(entry.ref, entry.intent)}\n\n${describeQueue(runtime)}`);
    },
  );

  server.registerTool(
    'media_play',
    {
      description:
        'Start or resume playback. With an id, plays that entry now. With nothing, resumes or starts the queue.',
      inputSchema: z.object({ id: z.string().optional() }),
    },
    async ({ id }) => {
      await runtime.play(id);
      return say(describeQueue(runtime));
    },
  );

  server.registerTool(
    'media_pause',
    { description: 'Pause playback.', inputSchema: z.object({}) },
    async () => {
      await runtime.pause();
      return say(describeQueue(runtime));
    },
  );

  server.registerTool(
    'media_next',
    { description: 'Skip to the next entry.', inputSchema: z.object({}) },
    async () => {
      await runtime.next();
      return say(describeQueue(runtime));
    },
  );

  server.registerTool(
    'media_seek',
    {
      description: 'Jump to a position in the current track. Fails if the backend cannot seek.',
      inputSchema: z.object({ seconds: z.number().min(0) }),
    },
    async ({ seconds }) => {
      // Asked rather than attempted: the model gets a usable sentence instead of
      // an exception, and learns something true about the backend it is on.
      if (!runtime.can('seek')) {
        return say(
          `the current source (${runtime.getPlayback().adapterId ?? 'none'}) cannot seek. ` +
            'Nothing changed.',
        );
      }
      await runtime.seek(seconds * 1000);
      return say(describeQueue(runtime));
    },
  );

  server.registerTool(
    'media_move',
    {
      description: 'Reorder the queue. Both ids come from media_queue.',
      inputSchema: z.object({
        id: z.string().describe('the entry to move'),
        after: z.string().optional().describe('put it after this entry; omit to put it next'),
      }),
    },
    async ({ id, after }) => {
      runtime.move(id, after ? { after } : { next: true });
      return say(describeQueue(runtime));
    },
  );

  server.registerTool(
    'media_remove',
    {
      description: 'Remove an entry from the queue, by id.',
      inputSchema: z.object({ id: z.string() }),
    },
    async ({ id }) => {
      runtime.remove(id);
      return say(describeQueue(runtime));
    },
  );

  server.registerTool(
    'media_search',
    {
      description:
        'Search the sources that can search. Returns ids you can pass to media_enqueue as a uri.',
      inputSchema: z.object({ query: z.string(), limit: z.number().int().max(25).optional() }),
    },
    async ({ query, limit }) => {
      const results = await runtime.search(query, { limit: limit ?? 8 });
      if (results.length === 0) {
        return say(
          `nothing found for “${query}”.\n\n${explainSetup(runtime)}`,
        );
      }
      return say(
        results
          .map((r) => `${r.uri ?? '(no uri)'}  ${label(r)}  [${r.adapterId}]`)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'media_adopt_current',
    {
      description:
        'Put whatever this machine is already playing — a browser tab, another app — into the queue, ' +
        'so your entries start when it finishes instead of cutting across it.',
      inputSchema: z.object({}),
    },
    async () => {
      const outside = await readNowPlaying();
      if (!outside) return say('nothing is playing elsewhere to adopt.');
      const entry = runtime.enqueue(NOW_PLAYING_URI, { next: true });
      return say(
        `adopted ${outside.title} (${outside.label}) as ${entry.id}\n\n${describeQueue(runtime)}`,
      );
    },
  );

  server.registerTool(
    'media_setup',
    {
      description:
        'What audio sources are wired here, and what they can do — including whether a plain description can be resolved.',
      inputSchema: z.object({}),
    },
    async () => say(explainSetup(runtime)),
  );

  return server;
}
