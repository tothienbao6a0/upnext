import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MediaRef } from '@upnext/core';

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.aiff',
  '.aif',
  '.flac',
  '.ogg',
  '.opus',
  '.wma',
]);

export function isAudioPath(value: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(value).toLowerCase());
}

/**
 * An in-memory index of audio files under the configured directories.
 *
 * It exists because `Adapter.match` is synchronous by contract — the runtime
 * calls it on every resolution and cannot afford to hit the filesystem — so
 * anything the adapter wants to claim by title has to be known up front.
 */
export class Library {
  #entries: MediaRef[] = [];

  get size(): number {
    return this.#entries.length;
  }

  async scan(roots: string[], maxDepth = 4): Promise<void> {
    const found: MediaRef[] = [];
    for (const root of roots) await walk(root, maxDepth, found);
    this.#entries = found;
  }

  /** Case-insensitive substring match over filename. Deliberately dumb. */
  search(query: string, limit = 10): MediaRef[] {
    const needle = query.toLowerCase().trim();
    if (!needle) return [];
    return this.#entries
      .filter((entry) => entry.title?.toLowerCase().includes(needle))
      .slice(0, limit);
  }

  /** Whether anything in the index could plausibly satisfy this ref. */
  has(title: string | undefined): boolean {
    return Boolean(title) && this.search(title!, 1).length > 0;
  }
}

async function walk(dir: string, depth: number, out: MediaRef[]): Promise<void> {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Unreadable directories are not worth failing a scan over.
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, depth - 1, out);
    } else if (isAudioPath(entry.name)) {
      out.push({
        title: basename(entry.name, extname(entry.name)),
        uri: pathToFileURL(full).href,
      });
    }
  }
}
