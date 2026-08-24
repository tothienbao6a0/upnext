import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canPlay, describeSource, score } from '../src/sources.js';

/**
 * The claim this adapter must not overreach on. "The browser can play anything"
 * is the intuition; an element plays a *stream*, not a *page*, and the gap
 * between those is where a queue full of last-second failures comes from.
 */

test('direct media URLs are certain', () => {
  for (const uri of [
    'https://example.com/episode.mp3',
    'https://cdn.example.com/track.m4a',
    'https://example.com/live.m3u8',
    'https://example.com/clip.webm',
  ]) {
    assert.equal(score({ uri }), 1, uri);
  }
});

test('a signed podcast URL still matches through its query string', () => {
  assert.equal(score({ uri: 'https://traffic.megaphone.fm/ABC123.mp3?updated=1712' }), 1);
  assert.equal(score({ uri: 'https://example.com/a.mp3#t=30' }), 1);
});

test('pages that merely contain media are refused outright', () => {
  for (const uri of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=x',
    'https://open.spotify.com/track/1OWBh1eVxUdA1Z6UA8r4nh',
    'https://music.apple.com/us/album/x/1',
    'https://soundcloud.com/artist/track',
    'https://artist.bandcamp.com/track/x',
  ]) {
    assert.equal(score({ uri }), 0, `${uri} is a page, not a stream`);
    assert.equal(canPlay(uri), false);
  }
});

test('an extensionless http URL is a last resort, not a refusal', () => {
  // Podcast enclosures are routinely extensionless redirects. Scoring low means
  // "after everything else", and the binder fails over if it was wrong.
  const s = score({ uri: 'https://example.com/download/12345' });
  assert.ok(s > 0 && s < 0.5, `expected a low non-zero score, got ${s}`);
});

test('blob and data URLs are certain; other schemes are not ours', () => {
  assert.equal(score({ uri: 'blob:https://example.com/abc' }), 1);
  assert.equal(score({ uri: 'data:audio/mpeg;base64,AAAA' }), 1);
  assert.equal(score({ uri: 'spotify:track:1OWBh1eVxUdA1Z6UA8r4nh' }), 0);
  assert.equal(score({ uri: 'data:text/html,hello' }), 0);
});

test('file URLs rank below http, because only some hosts allow them', () => {
  assert.ok(score({ uri: 'file:///music/song.mp3' }) < score({ uri: 'https://x.com/song.mp3' }));
  assert.equal(score({ uri: 'file:///notes/todo.txt' }), 0);
});

test('a ref with no locator is nothing to us', () => {
  assert.equal(score({ title: 'Nights', artist: 'Frank Ocean' }), 0);
});

test('a host can teach it about formats its element handles', () => {
  assert.equal(score({ uri: 'https://x.com/a.dsf' }), 0);
  assert.equal(score({ uri: 'https://x.com/a.dsf' }, ['.dsf']), 1);
});

test('a queue shows names rather than a column of URLs', () => {
  assert.equal(describeSource('https://example.com/shows/the-daily.mp3'), 'the-daily');
  assert.equal(describeSource('https://example.com/'), 'example.com');
  assert.equal(describeSource('https://example.com/a%20b.mp3'), 'a b');
});

test('a URL that names a format we do not handle is a no, not a maybe', () => {
  // The bug this covers: `.html` once scored the same as an extensionless
  // enclosure and would have been tried hopefully, then failed to decode.
  for (const uri of [
    'https://example.com/article.html',
    'https://example.com/feed.json',
    'https://example.com/image.png',
  ]) {
    assert.equal(score({ uri }), 0, uri);
  }
});

test('a dot in a directory name is not an extension', () => {
  assert.equal(score({ uri: 'https://example.com/v1.2/download' }), 0.2);
});
