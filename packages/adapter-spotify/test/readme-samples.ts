/**
 * Every code sample from the READMEs that touches this package.
 *
 * Not a test — it is never executed. It is here so `tsc` reads the samples,
 * because a README that does not compile is worse than one that is out of date:
 * out of date is discovered by reading, a broken sample is discovered by a
 * stranger pasting it and concluding the project does not work.
 *
 * The file name deliberately does not end in `.test.ts`, so the runner skips it.
 */
import { Runtime } from 'upnext-core';
import { LocalAdapter } from 'upnext-adapter-local';
import { SpotifyDesktopAdapter, SpotifyWebAdapter } from '../src/index.js';

declare const myTokenStore: { current(): string };
declare const myOsascript: (script: string) => Promise<string>;
declare const myFetch: typeof globalThis.fetch;

export async function rootReadmeQuickstart(): Promise<void> {
  const runtime = new Runtime({
    adapters: [new LocalAdapter({ library: ['/Users/you/Music'] }), new SpotifyDesktopAdapter()],
  });

  runtime.enqueue('https://open.spotify.com/track/1OWBh1eVxUdA1Z6UA8r4nh');
  runtime.enqueue('file:///path/to/second.mp3');
  await runtime.play();
}

export async function rootReadmeTopExample(): Promise<void> {
  const runtime = new Runtime({ adapters: [new SpotifyDesktopAdapter()] });
  runtime.enqueue('spotify:track:1OWBh1eVxUdA1Z6UA8r4nh');
  runtime.enqueue('https://example.com/interview.mp3');
  runtime.enqueue('file:///voice-memos/ruby.m4a');
  runtime.enqueue('something calmer after those');
  await runtime.play();
}

export function rootReadmeTraversal(runtime: Runtime): void {
  runtime.setRepeat('all');
  runtime.setShuffle(true);
  if (runtime.can('seek')) void runtime.seek(30_000);
  void runtime.can('search');
}

export function rootReadmePersistence(runtime: Runtime): number {
  const saved = runtime.serialize();
  const { positionMs } = runtime.restore(saved);
  return positionMs;
}

export function packageReadmeWebAdapter(): SpotifyWebAdapter {
  return new SpotifyWebAdapter({
    getAccessToken: () => myTokenStore.current(),
    deviceId: 'optional-specific-speaker',
  });
}

export async function packageReadmeExpandContext(runtime: Runtime): Promise<void> {
  const spotify = new SpotifyWebAdapter({ getAccessToken: () => myTokenStore.current() });
  const tracks = await spotify.expandContext('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
  runtime.enqueueMany(tracks.slice(0, 10));
}

export function packageReadmeOptions(): void {
  new SpotifyDesktopAdapter({
    id: 'spotify-desktop',
    sampleIntervalMs: 1000,
    lookup: null,
    osascript: myOsascript,
  });

  new SpotifyWebAdapter({
    getAccessToken: () => myTokenStore.current(),
    id: 'spotify-web',
    deviceId: 'device',
    market: 'US',
    sampleIntervalMs: 2000,
    fetch: myFetch,
  });
}

export function packageReadmeDesyncPolicies(): void {
  new Runtime({ desyncPolicy: 'adopt' });
  new Runtime({ desyncPolicy: 'correct' });
  new Runtime({ desyncPolicy: 'ignore' });
}
