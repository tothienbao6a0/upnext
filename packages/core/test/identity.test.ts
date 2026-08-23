import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityKey, normalizeText, primaryArtist, similarity } from '../src/identity.js';

test('normalization strips the noise that differs between catalogues', () => {
  assert.equal(normalizeText('Nights (Remastered 2016)'), 'nights');
  assert.equal(normalizeText('Bad Habit - Radio Edit'), 'bad habit radio edit');
  assert.equal(normalizeText('Me & You (feat. Someone)'), 'me and you');
});

test('primary artist ignores features and collaborators', () => {
  assert.equal(primaryArtist('Steve Lacy feat. Bad Bunny'), 'steve lacy');
  assert.equal(primaryArtist('Calvin Harris & Dua Lipa'), 'calvin harris');
});

test('a comma inside a name is not a separator', () => {
  assert.equal(primaryArtist('Tyler, The Creator'), 'tyler the creator');
});

test('strong ids win over metadata for identity', () => {
  const a = { title: 'Whatever', artist: 'Nobody', isrc: 'usum71703861' };
  const b = { title: 'Completely Different', artist: 'Someone Else', isrc: 'USUM71703861' };
  assert.equal(identityKey(a), identityKey(b));
});

test('a matching ISRC is conclusive; a mismatching one is fatal', () => {
  assert.equal(similarity({ isrc: 'ABC' }, { isrc: 'abc' }), 1);
  assert.equal(similarity({ isrc: 'ABC', title: 'Same' }, { isrc: 'XYZ', title: 'Same' }), 0);
});

test('the same song across two catalogues scores high', () => {
  const spotify = { title: 'Bad Habit', artist: 'Steve Lacy', durationMs: 232_000 };
  const apple = {
    title: 'Bad Habit (Remastered)',
    artist: 'Steve Lacy feat. Nobody',
    durationMs: 233_500,
  };
  assert.ok(similarity(spotify, apple) > 0.8);
});

test('different songs by the same artist score low', () => {
  const a = { title: 'Bad Habit', artist: 'Steve Lacy' };
  const b = { title: 'Static', artist: 'Steve Lacy' };
  assert.ok(similarity(a, b) < 0.55);
});

test('a wildly different duration is treated as a different cut', () => {
  const studio = { title: 'Nights', artist: 'Frank Ocean', durationMs: 307_000 };
  const live = { title: 'Nights', artist: 'Frank Ocean', durationMs: 620_000 };
  assert.ok(similarity(studio, live) < similarity(studio, { ...studio }));
});
