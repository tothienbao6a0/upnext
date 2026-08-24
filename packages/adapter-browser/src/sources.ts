import type { MediaRef } from 'upnext-core';

/**
 * What a media element can and cannot be handed.
 *
 * The temptation with a browser adapter is to claim the web, because "the
 * browser can play anything" feels true. It is not. An `<audio>` element plays
 * a *media stream*; it does not play a *page*. Handing it a YouTube watch URL
 * gets you a lump of HTML and a decode error, and the difference matters
 * because a queue full of things that fail at the last moment is worse than one
 * that admitted it could not take them.
 */

/** Container and codec extensions a media element will normally accept. */
const PLAYABLE_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.m4b', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus',
  '.weba', '.webm', '.mp4', '.m4v', '.mov', '.aiff', '.aif', '.caf',
  // Adaptive manifests. Native only in Safari without a library, but a host
  // that has attached hls.js to its element makes these work, and the element
  // is the host's to configure.
  '.m3u8', '.mpd',
]);

/**
 * Pages that play media *inside* them, which is not the same as being media.
 *
 * Listed explicitly and scored zero rather than left to fall through the
 * extension check, because these are exactly what somebody will try first. A
 * silent zero sends the entry to another adapter or fails it honestly; a
 * hopeful guess plays nothing and blames the file.
 *
 * Making these work needs a page-level integration — YouTube's IFrame player,
 * a SoundCloud widget, a stream extractor — which is a different adapter with
 * different terms of service, not a smarter regex here.
 */
const PAGE_HOSTS = [
  'youtube.com', 'youtu.be', 'music.youtube.com',
  'open.spotify.com', 'music.apple.com',
  'soundcloud.com', 'bandcamp.com', 'mixcloud.com',
  'vimeo.com', 'twitch.tv',
];

export function canPlay(uri: string, extraExtensions?: string[]): boolean {
  return score({ uri }, extraExtensions) > 0;
}

/**
 * How confident this element is that it can play the ref.
 *
 * A direct media URL scores 1. An `http(s)` URL with no recognisable extension
 * scores low but non-zero — podcast enclosures are routinely extensionless
 * redirects, and "try me last" is the honest answer for those: if it fails,
 * the binder moves to the next source, which is exactly the machinery for it.
 */
export function score(ref: MediaRef, extraExtensions?: string[]): number {
  const uri = ref.uri;
  if (!uri) return 0;

  // Anything the host has already turned into bytes is certain.
  if (uri.startsWith('blob:')) return 1;
  if (uri.startsWith('data:audio/') || uri.startsWith('data:video/')) return 1;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase();

  const extension = extensionOf(uri);
  const known = extension !== null && isKnown(extension, extraExtensions);

  if (scheme === 'file') {
    // Works in an Electron renderer and in a webview; a plain web page will be
    // refused by the browser itself. Below a direct http URL, above a guess.
    return known ? 0.8 : 0;
  }

  if (scheme !== 'http' && scheme !== 'https') return 0;
  if (isPage(uri)) return 0;
  if (known) return 1;

  // A URL that *names* a format we do not handle is a no, not a maybe —
  // `.html` and `.json` are not things to try hopefully and fail on.
  if (extension !== null) return 0;

  // No extension at all. Podcast enclosures are routinely extensionless
  // redirects, so this is worth trying once nothing better has offered.
  return 0.2;
}

/** A short label for a URL, so a queue does not show a column of raw links. */
export function describeSource(uri: string): string {
  try {
    const url = new URL(uri);
    const last = url.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last.replace(/\.[^.]+$/, ''));
    return url.hostname;
  } catch {
    return uri;
  }
}

function isPage(uri: string): boolean {
  let host: string;
  try {
    host = new URL(uri).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  return PAGE_HOSTS.some((page) => host === page || host.endsWith(`.${page}`));
}

/** The extension of the last path segment, or null when there isn't one. */
function extensionOf(uri: string): string | null {
  // Query strings and fragments are stripped first: signed podcast URLs carry
  // `?updated=...` after the extension and would otherwise never match.
  const path = uri.split(/[?#]/)[0] ?? '';
  const segment = path.slice(path.lastIndexOf('/') + 1);
  const dot = segment.lastIndexOf('.');
  // A leading dot is a hidden file, not an extension.
  if (dot <= 0) return null;
  return segment.slice(dot).toLowerCase();
}

function isKnown(extension: string, extra?: string[]): boolean {
  return PLAYABLE_EXTENSIONS.has(extension) || (extra?.includes(extension) ?? false);
}
