import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPlayableKind, parseSpotifyUri, toSpotifyUri, toSpotifyUrl } from '../src/uri.js';

/**
 * Both of Spotify's names for the same thing have to arrive at the same place.
 * A share link pasted by a person and a URI returned by an API are the same
 * track, and an adapter that only understood one of them would look broken to
 * whichever half of its users had the other.
 */

const ID = '6f3Slt0GbA2bPZlz0aIFXN';

test('the two forms of the same track parse identically', () => {
  const fromUri = parseSpotifyUri(`spotify:track:${ID}`);
  const fromUrl = parseSpotifyUri(`https://open.spotify.com/track/${ID}`);
  assert.deepEqual(fromUri, { kind: 'track', id: ID });
  assert.deepEqual(fromUrl, fromUri);
});

test('a share link keeps its meaning through the tracking parameters', () => {
  const parsed = parseSpotifyUri(`https://open.spotify.com/track/${ID}?si=abc123&utm_source=copy`);
  assert.deepEqual(parsed, { kind: 'track', id: ID });
});

test('a locale segment is absorbed, because half of real share links have one', () => {
  // What the mobile app produces when someone shares from a non-English device.
  assert.deepEqual(parseSpotifyUri(`https://open.spotify.com/intl-de/track/${ID}`), {
    kind: 'track',
    id: ID,
  });
  assert.deepEqual(parseSpotifyUri(`https://open.spotify.com/intl-pt-br/track/${ID}`), {
    kind: 'track',
    id: ID,
  });
});

test('the legacy user-scoped playlist form still resolves', () => {
  assert.deepEqual(parseSpotifyUri(`spotify:user:someone:playlist:${ID}`), {
    kind: 'playlist',
    id: ID,
  });
});

test('containers are recognised but are not playable items', () => {
  for (const kind of ['album', 'playlist', 'artist', 'show'] as const) {
    const parsed = parseSpotifyUri(`spotify:${kind}:${ID}`);
    assert.equal(parsed?.kind, kind, `${kind} should still be identified`);
    assert.equal(
      isPlayableKind(parsed!.kind),
      false,
      `${kind} is a container, not one thing to put in a queue`,
    );
  }
  assert.equal(isPlayableKind('track'), true);
  assert.equal(isPlayableKind('episode'), true);
});

test('anything that is not a Spotify locator answers null rather than throwing', () => {
  for (const value of [
    undefined,
    null,
    '',
    '   ',
    'something calmer after this',
    'file:///music/song.mp3',
    'https://example.com/track/6f3Slt0GbA2bPZlz0aIFXN',
    'https://open.spotify.com/',
    'https://open.spotify.com/track/',
    'spotify:local:artist:album:track:123',
    'spotify:track:',
    'not a url at all: [',
  ]) {
    assert.equal(parseSpotifyUri(value as string), null, `${String(value)} should not parse`);
  }
});

test('a lookalike host is not Spotify', () => {
  assert.equal(parseSpotifyUri(`https://open.spotify.com.evil.test/track/${ID}`), null);
  assert.equal(parseSpotifyUri(`https://notspotify.com/track/${ID}`), null);
});

test('a genuine Spotify subdomain is', () => {
  assert.deepEqual(parseSpotifyUri(`https://play.spotify.com/track/${ID}`), {
    kind: 'track',
    id: ID,
  });
});

test('parsing round-trips through both output forms', () => {
  const parsed = parseSpotifyUri(`https://open.spotify.com/intl-fr/track/${ID}?si=x`)!;
  assert.equal(toSpotifyUri(parsed), `spotify:track:${ID}`);
  assert.equal(toSpotifyUrl(parsed), `https://open.spotify.com/track/${ID}`);
  assert.deepEqual(parseSpotifyUri(toSpotifyUrl(parsed)), parsed);
});
