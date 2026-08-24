import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStatus, classifyText } from '../src/errors.js';
import { clearMetadataCache, readEmbedHtml } from '../src/metadata.js';
import { readTrack, searchQuery } from '../src/ref.js';

/**
 * The two payloads this package reads that it does not own.
 *
 * One is a documented API that has changed its shapes before; the other is a
 * web page that can change without anybody being told. Neither is trusted, and
 * the tests here are mostly about what happens when they are wrong — because a
 * `durationMs` of `NaN` is not a missing field, it is a number the runtime will
 * use to decide a track is over.
 */

test('a track is read into a ref, ISRC and all', () => {
  const ref = readTrack({
    uri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA',
    name: '  Bad Habit  ',
    duration_ms: 233_000,
    artists: [{ name: 'Steve Lacy' }, { name: 'Someone Else' }],
    album: { name: 'Gemini Rights', images: [{ url: 'https://i.scdn.co/big.jpg', width: 640 }] },
    external_ids: { isrc: 'usum72209293' },
  });
  assert.equal(ref?.title, 'Bad Habit');
  assert.equal(ref?.artist, 'Steve Lacy, Someone Else');
  assert.equal(ref?.isrc, 'USUM72209293', 'normalised, since it is a join key');
  assert.equal(ref?.album, 'Gemini Rights');
  assert.equal(ref?.artwork, 'https://i.scdn.co/big.jpg');
});

test('artists survive either shape they arrive in', () => {
  // The Web API sends objects; tools that normalise Spotify's payloads flatten
  // them to plain strings. An out-of-process adapter may have been through one.
  assert.equal(readTrack({ name: 'x', artists: ['A', 'B'] })?.artist, 'A, B');
  assert.equal(readTrack({ name: 'x', artists: [{ name: 'A' }] })?.artist, 'A');
});

test('a podcast episode keeps its show and its cover', () => {
  const ref = readTrack({
    uri: 'spotify:episode:AAAAAAAAAAAAAAAAAAAAAA',
    name: 'Episode 1',
    duration_ms: 1000,
    images: [{ url: 'https://i.scdn.co/show.jpg', width: 640 }],
    show: { name: 'A Podcast' },
  });
  assert.equal(ref?.artist, 'A Podcast', 'an episode has no artists; the show is the byline');
  assert.equal(ref?.artwork, 'https://i.scdn.co/show.jpg');
});

test('junk fields are dropped rather than carried through as numbers', () => {
  const ref = readTrack({
    uri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA',
    name: 'x',
    duration_ms: 'not a number',
    artists: 'not an array',
    external_ids: { isrc: 'TOO-SHORT' },
    album: { images: [{ url: 'http://insecure.example/x.jpg', width: 640 }] },
  });
  assert.equal(ref?.durationMs, undefined, 'a NaN duration would end tracks early');
  assert.equal(ref?.artist, undefined);
  assert.equal(ref?.isrc, undefined, 'a malformed ISRC is worse than none: it is a bad join key');
  assert.equal(ref?.artwork, undefined, 'plain http artwork is not carried');
});

test('a payload with neither a name nor a URI is not a track', () => {
  assert.equal(readTrack(null), null);
  assert.equal(readTrack('a string'), null);
  assert.equal(readTrack({}), null);
  assert.equal(readTrack({ duration_ms: 1000 }), null);
});

test('search queries are fielded, and drop the featuring credits that never match', () => {
  assert.equal(searchQuery({ isrc: 'USUM72209293' }), 'isrc:USUM72209293');
  assert.equal(
    searchQuery({ title: 'Bad Habit', artist: 'Steve Lacy feat. Someone' }),
    'track:"Bad Habit" artist:"Steve Lacy"',
  );
  // A quote in a title would end the field early and turn the rest of the
  // title into stray query syntax, so it becomes a space and the gap closes up.
  assert.equal(searchQuery({ title: 'A "quoted" title' }), 'track:"A quoted title"');
  assert.equal(searchQuery({}), null, 'nothing to ask for');
});

test('the embed page yields a title, an artist and a cover', () => {
  clearMetadataCache();
  const html = embedPage({
    name: 'Bad Habit',
    artists: [{ name: 'Steve Lacy' }],
    duration: 233_000,
    visualIdentity: {
      image: [
        { url: 'https://i.scdn.co/small.jpg', maxWidth: 64 },
        { url: 'https://i.scdn.co/right.jpg', maxWidth: 300 },
        { url: 'https://i.scdn.co/huge.jpg', maxWidth: 1200 },
      ],
    },
  });
  assert.deepEqual(readEmbedHtml(html), {
    title: 'Bad Habit',
    artist: 'Steve Lacy',
    durationMs: 233_000,
    artwork: 'https://i.scdn.co/right.jpg',
  });
});

test('a page that has changed shape costs a title, not a crash', () => {
  // This is scraped from a page nobody promised would stay the same, so every
  // failure has to be survivable. Nothing about whether a track plays runs
  // through here.
  assert.deepEqual(readEmbedHtml('<html>a completely different page</html>'), {});
  assert.deepEqual(readEmbedHtml(embedPageRaw('not json at all')), {});
  assert.deepEqual(readEmbedHtml(embedPage(null)), {});
  assert.deepEqual(readEmbedHtml(embedPage({ artists: 'nope' })), {});
});

test('HTTP failures are bucketed by what the caller would have to do about them', () => {
  assert.equal(classifyStatus(401), 'unauthorized');
  assert.equal(classifyStatus(403, { error: { reason: 'PREMIUM_REQUIRED' } }), 'premium-required');
  assert.equal(classifyStatus(403, {}), 'unauthorized');
  assert.equal(classifyStatus(404, { error: { reason: 'NO_ACTIVE_DEVICE' } }), 'no-device');
  assert.equal(classifyStatus(404, {}), 'not-found');
  assert.equal(classifyStatus(500), 'failed');
});

test('rate limiting is checked before anything that mentions a user', () => {
  // A throttling message can carry the word "user" in its body, and reading it
  // as an auth failure would send a host off to re-authenticate when all it
  // needed to do was wait.
  assert.equal(classifyStatus(429, { error: { message: 'invalid user' } }), 'rate-limited');
  assert.equal(classifyText('Rate limited: too many requests for this user'), 'rate-limited');
});

test('osascript prose is bucketed the same way, since it has no status codes', () => {
  assert.equal(classifyText('Not authorized to send Apple events to Spotify. (-1743)'), 'unauthorized');
  assert.equal(classifyText('Application isn’t running. (-600)'), 'no-device');
  assert.equal(classifyText('Can’t get application "Spotify". (-1728)'), 'not-found');
  assert.equal(classifyText('something nobody has seen before'), 'failed');
});

function embedPage(entity: unknown): string {
  return embedPageRaw(JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } }));
}

function embedPageRaw(json: string): string {
  return `<html><head><script id="__NEXT_DATA__" type="application/json">${json}</script></head></html>`;
}
