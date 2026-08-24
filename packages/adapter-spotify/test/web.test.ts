import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManualScheduler, Runtime } from 'upnext-core';
import { SpotifyError } from '../src/errors.js';
import { SpotifyWebAdapter, toSample } from '../src/web.js';
import { flush } from './fixtures.js';

/**
 * The Web API backend, against a stand-in for Spotify.
 *
 * Everything here is about the parts a real account would hide rather than
 * reveal: what happens when the token expires mid-queue, when the account is
 * free, when nothing is awake to play on. Those are the states a developer
 * meets on their first afternoon and the ones an integration is judged by.
 */

const TRACK_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const URI = `spotify:track:${TRACK_ID}`;

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  token: string | null;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A minimal `fetch` that records what it was asked and answers from a table. */
function fakeApi(reply: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const call: Call = {
      method: init.method ?? 'GET',
      path: url.pathname.replace(/^\/v1/, ''),
      query: Object.fromEntries(url.searchParams),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      token: String((init.headers as Record<string, string>)?.authorization ?? '').replace(
        'Bearer ',
        '',
      ) || null,
    };
    calls.push(call);
    const { status, body, headers } = reply(call);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const TRACK_BODY = {
  uri: URI,
  name: 'Bad Habit',
  duration_ms: 233_000,
  artists: [{ name: 'Steve Lacy' }],
  album: { name: 'Gemini Rights', images: [{ url: 'https://i.scdn.co/x.jpg', width: 640 }] },
  external_ids: { isrc: 'USUM72209293' },
};

test('a track URI resolves into a ref carrying its ISRC', async () => {
  const { fetch, calls } = fakeApi(() => ({ status: 200, body: TRACK_BODY }));
  const adapter = new SpotifyWebAdapter({ getAccessToken: () => 'tok', fetch });

  const binding = await adapter.resolve({ uri: URI });
  assert.equal(binding?.nativeUri, URI);
  assert.equal(binding?.ref.title, 'Bad Habit');
  assert.equal(binding?.ref.artist, 'Steve Lacy');
  assert.equal(binding?.ref.durationMs, 233_000);
  assert.equal(
    binding?.ref.isrc,
    'USUM72209293',
    'the recording id is what lets this entry survive without Spotify',
  );
  assert.equal(calls[0]?.path, `/tracks/${TRACK_ID}`);
});

test('a ref with no URI is found by search, ISRC first', async () => {
  const { fetch, calls } = fakeApi(() => ({ status: 200, body: { tracks: { items: [TRACK_BODY] } } }));
  const adapter = new SpotifyWebAdapter({ getAccessToken: () => 'tok', fetch });

  await adapter.resolve({ isrc: 'USUM72209293' });
  assert.equal(calls[0]?.query.q, 'isrc:USUM72209293');

  await adapter.resolve({ title: 'Bad Habit', artist: 'Steve Lacy' });
  assert.equal(
    calls[1]?.query.q,
    'track:"Bad Habit" artist:"Steve Lacy"',
    'a fielded query, because free text returns covers above originals often enough to matter',
  );
});

test('match scores what it can actually deliver', () => {
  const adapter = new SpotifyWebAdapter({ getAccessToken: () => 'tok' });
  assert.equal(adapter.match({ uri: URI }), 1);
  assert.equal(adapter.match({ isrc: 'USUM72209293' }), 0.9);
  assert.equal(adapter.match({ title: 'Bad Habit' }), 0.65);
  assert.equal(adapter.match({ uri: 'spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA' }), 0);
  assert.equal(adapter.match({ uri: 'file:///song.mp3' }), 0);
  assert.equal(adapter.match({}), 0);
});

test('starting a track sends one URI, not a context to wander off into', async () => {
  const { fetch, calls } = fakeApi((call) =>
    call.path === `/tracks/${TRACK_ID}` ? { status: 200, body: TRACK_BODY } : { status: 204 },
  );
  const adapter = new SpotifyWebAdapter({
    getAccessToken: () => 'tok',
    fetch,
    deviceId: 'device-1',
  });

  const binding = await adapter.resolve({ uri: URI });
  await adapter.load(binding!, { startAtMs: 30_000 });
  await adapter.play();

  const play = calls.find((call) => call.path === '/me/player/play');
  assert.deepEqual(play?.body, { uris: [URI], position_ms: 30_000 });
  assert.equal(play?.query.device_id, 'device-1');
  await adapter.dispose();
});

test('resuming does not restart the song from zero', async () => {
  const { fetch, calls } = fakeApi(() => ({ status: 204 }));
  const adapter = new SpotifyWebAdapter({ getAccessToken: () => 'tok', fetch });
  await adapter.load({ adapterId: 'spotify-web', nativeUri: URI, ref: { uri: URI } });
  await adapter.play();
  await adapter.play();

  const plays = calls.filter((call) => call.path === '/me/player/play');
  assert.deepEqual(plays[0]?.body, { uris: [URI] });
  assert.equal(plays[1]?.body, undefined, 'a bodyless play is the API’s resume');
  await adapter.dispose();
});

test('an expired token is refreshed once and the call retried', async () => {
  let issued = 0;
  const { fetch, calls } = fakeApi((call) =>
    call.token === 'stale' ? { status: 401, body: { error: { message: 'expired' } } } : { status: 200, body: TRACK_BODY },
  );
  const adapter = new SpotifyWebAdapter({
    getAccessToken: () => (issued++ === 0 ? 'stale' : 'fresh'),
    fetch,
  });

  // Tokens last an hour and a queue outlives that easily, so a 401 partway
  // through is an ordinary event rather than a failure.
  const binding = await adapter.resolve({ uri: URI });
  assert.equal(binding?.ref.title, 'Bad Habit');
  assert.deepEqual(
    calls.map((call) => call.token),
    ['stale', 'fresh'],
  );
});

test('a token that keeps failing gives up rather than spinning', async () => {
  const { fetch, calls } = fakeApi(() => ({ status: 401, body: { error: { message: 'nope' } } }));
  const adapter = new SpotifyWebAdapter({ getAccessToken: () => 'bad', fetch });

  await assert.rejects(
    () => adapter.resolve({ uri: URI }),
    (err: unknown) => err instanceof SpotifyError && err.reason === 'unauthorized',
  );
  assert.equal(calls.length, 2, 'one retry, not a loop');
});

test('concurrent calls that hit an expiry share one refresh', async () => {
  // Lookahead resolves several entries at once. Without a single flight they
  // would each fetch a token, which trips the host's own limits at exactly the
  // moment everything is already failing.
  let issued = 0;
  const { fetch } = fakeApi((call) =>
    call.token === 'stale' ? { status: 401 } : { status: 200, body: TRACK_BODY },
  );
  const adapter = new SpotifyWebAdapter({
    getAccessToken: async () => (issued++ === 0 ? 'stale' : 'fresh'),
    fetch,
  });

  await Promise.all([
    adapter.resolve({ uri: URI }),
    adapter.resolve({ uri: URI }),
    adapter.resolve({ uri: URI }),
  ]);
  assert.equal(issued, 2, 'one initial token and one refresh, however many callers');
});

test('the failures a developer actually meets are named, not lumped together', async () => {
  const cases: Array<[Reply, string]> = [
    [{ status: 404, body: { error: { reason: 'NO_ACTIVE_DEVICE' } } }, 'no-device'],
    [{ status: 403, body: { error: { reason: 'PREMIUM_REQUIRED' } } }, 'premium-required'],
    [{ status: 403, body: { error: { message: 'insufficient scope' } } }, 'unauthorized'],
    [{ status: 429, body: {}, headers: { 'retry-after': '30' } }, 'rate-limited'],
    [{ status: 500, body: {} }, 'failed'],
  ];

  for (const [reply, expected] of cases) {
    const { fetch } = fakeApi(() => reply);
    const adapter = new SpotifyWebAdapter({ getAccessToken: () => 'tok', fetch });
    await adapter.load({ adapterId: 'spotify-web', nativeUri: URI, ref: { uri: URI } });
    await assert.rejects(
      () => adapter.play(),
      (err: unknown) => {
        assert.ok(err instanceof SpotifyError, `expected a SpotifyError for ${reply.status}`);
        assert.equal(err.reason, expected, `status ${reply.status}`);
        return true;
      },
    );
    await adapter.dispose();
  }
});

test('a rate limit carries how long to wait, when Spotify says', async () => {
  const { fetch } = fakeApi(() => ({ status: 429, body: {}, headers: { 'retry-after': '30' } }));
  const adapter = new SpotifyWebAdapter({ getAccessToken: () => 'tok', fetch });
  await assert.rejects(
    () => adapter.search('anything'),
    (err: unknown) => err instanceof SpotifyError && err.retryAfterMs === 30_000,
  );
});

test('a track Spotify does not have is "not me", not a broken entry', async () => {
  // Returning null lets the runtime try another source; throwing would condemn
  // the queue entry over one catalogue's gap.
  const { fetch } = fakeApi(() => ({ status: 404, body: { error: { message: 'non existing id' } } }));
  const adapter = new SpotifyWebAdapter({ getAccessToken: () => 'tok', fetch });
  assert.equal(await adapter.resolve({ uri: URI }), null);
});

test('stopping tolerates a device that already stopped', async () => {
  // The runtime stops the outgoing backend on every transition, and by then the
  // device may have slept. Failing the transition over that would be absurd.
  const { fetch } = fakeApi((call) =>
    call.path === '/me/player/pause' ? { status: 403, body: { error: { reason: 'UNKNOWN' } } } : { status: 204 },
  );
  const adapter = new SpotifyWebAdapter({ getAccessToken: () => 'tok', fetch });
  await adapter.load({ adapterId: 'spotify-web', nativeUri: URI, ref: { uri: URI } });
  await adapter.play();
  await adapter.stop();
  await adapter.dispose();
});

test('an album or playlist expands into entries rather than being played whole', async () => {
  const { fetch, calls } = fakeApi((call) =>
    call.path.startsWith('/playlists')
      ? { status: 200, body: { items: [{ track: TRACK_BODY }, { track: TRACK_BODY }] } }
      : { status: 200, body: { items: [TRACK_BODY] } },
  );
  const adapter = new SpotifyWebAdapter({ getAccessToken: () => 'tok', fetch });

  const album = await adapter.expandContext(`spotify:album:${TRACK_ID}`);
  assert.equal(album.length, 1);
  const playlist = await adapter.expandContext(`spotify:playlist:${TRACK_ID}`);
  assert.equal(playlist.length, 2, 'a playlist wraps each track one level down');
  assert.equal(playlist[0]?.title, 'Bad Habit');
  assert.deepEqual(await adapter.expandContext(URI), [], 'a track is not a container');
  assert.equal(calls.length, 2);
});

test('player state maps onto the same sample both backends are read through', () => {
  assert.deepEqual(
    toSample({
      is_playing: true,
      progress_ms: 42_000,
      item: { uri: URI, duration_ms: 233_000 },
      device: { volume_percent: 60 },
    }),
    {
      running: true,
      status: 'playing',
      positionMs: 42_000,
      durationMs: 233_000,
      nativeUri: URI,
      volume: 0.6,
    },
  );
});

test('no active device reads the same as the desktop app being closed', () => {
  // A 204 arrives here as null. Nothing is playing and there is nowhere for it
  // to play, which is the same situation, so it gets the same answer.
  assert.equal(toSample(null).running, false);
  assert.equal(toSample(null).nativeUri, null);
});

test('the backend declares search, which is the whole reason it exists', async () => {
  const { fetch } = fakeApi(() => ({ status: 200, body: { tracks: { items: [TRACK_BODY] } } }));
  const adapter = new SpotifyWebAdapter({ getAccessToken: () => 'tok', fetch });
  assert.equal(adapter.capabilities.search, true);

  const runtime = new Runtime({ adapters: [adapter], scheduler: new ManualScheduler() });
  await flush();
  const hits = await runtime.search('bad habit');
  assert.equal(hits[0]?.title, 'Bad Habit');
  assert.equal(hits[0]?.adapterId, 'spotify-web');
  await runtime.dispose();
});

test('a token the host cannot supply fails at startup with a readable reason', async () => {
  const { fetch } = fakeApi(() => ({ status: 200, body: null }));
  const adapter = new SpotifyWebAdapter({ getAccessToken: () => '', fetch });
  const runtime = new Runtime({ adapters: [adapter] });
  await flush();

  const summary = runtime.getState().adapters[0];
  assert.equal(summary?.available, false);
  assert.match(String(summary?.error?.message), /did not return an access token/);
  await runtime.dispose();
});
