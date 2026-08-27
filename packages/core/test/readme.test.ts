import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * The README, checked against the repository.
 *
 * Written after the top of the README spent two days claiming Apple Music and
 * the MCP server were not built, while both were published. The bottom section
 * had been corrected and the summary above it had not — which is the ordinary
 * way documentation rots: not by being wrong when written, but by being right
 * in one place and stale in another.
 *
 * A prose file cannot be typechecked, so the parts that are really claims about
 * the repository get asserted instead. If a package appears, disappears, or is
 * still listed as unbuilt after it ships, this fails rather than a reader
 * finding out.
 */

const root = new URL('../../../../', import.meta.url).pathname;
const readme = readFileSync(join(root, 'README.md'), 'utf8');

/** Every publishable package, from the filesystem rather than from a list. */
function published(): string[] {
  return readdirSync(join(root, 'packages'))
    .map((dir) => {
      try {
        return JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as {
          name: string;
          private?: boolean;
        };
      } catch {
        return null;
      }
    })
    .filter((pkg): pkg is { name: string; private?: boolean } => Boolean(pkg) && !pkg!.private)
    .map((pkg) => pkg.name)
    .sort();
}

test('every published package is named in the README', () => {
  for (const name of published()) {
    assert.ok(readme.includes(name), `${name} is published but never mentioned`);
  }
});

test('the README does not advertise a package that does not exist', () => {
  const advertised = [...readme.matchAll(/`(upnext-[a-z-]+)`/g)].map((m) => m[1]!);
  const real = new Set(published());
  for (const name of new Set(advertised)) {
    // Subpath imports like `upnext-core/testing` are matched by their base.
    const base = name.split('/')[0]!;
    assert.ok(real.has(base), `README mentions ${name}, which is not a package here`);
  }
});

test('nothing listed as unbuilt has actually been built', () => {
  // The drift this exists for: Apple Music and MCP shipped while the summary
  // still called them unbuilt.
  //
  // Only the *subject* of a claim counts, not every mention. A section may
  // perfectly well say "Spotify and Apple Music are not gapless" — that is a
  // limitation of something shipped, not a claim it is missing. Subjects are
  // the comma list after "Not built yet:" and the bolded lead of each bullet.
  const claimed: string[] = [];

  for (const match of readme.matchAll(/\*\*Not built yet:\*\*([^.]*?)\./g)) {
    claimed.push(...(match[1] ?? '').split(/,| and /));
  }
  const sections = [...readme.matchAll(/\*\*Not built yet:\*\*\n([\s\S]*?)(?=\n##|\n---)/g)];
  for (const section of sections) {
    for (const bullet of (section[1] ?? '').matchAll(/^- \*\*(.+?)\*\*/gm)) {
      claimed.push(bullet[1] ?? '');
    }
  }

  assert.ok(claimed.length > 0, 'expected some "Not built yet" claims to check');

  const shipped: Array<[string, RegExp]> = [
    ['upnext-adapter-apple-music', /apple music/i],
    ['upnext-mcp', /\bMCP\b/],
    ['upnext-adapter-spotify', /^\s*spotify/i],
    ['upnext-adapter-browser', /^\s*browser adapter/i],
  ];

  for (const subject of claimed) {
    for (const [pkg, claim] of shipped) {
      if (!published().includes(pkg)) continue;
      assert.ok(
        !claim.test(subject.trim()),
        `${pkg} ships, but "Not built yet" lists it as a subject: "${subject.trim()}"`,
      );
    }
  }
});

test('no hardcoded test count, because it is stale the moment it is written', () => {
  // It was: the README said 325 while the suite was 329, off by exactly the
  // four tests added to this file to stop the README drifting. A number that
  // changes on every commit does not belong in prose.
  const counts = [...readme.matchAll(/\b(\d{2,})\s+tests\b/g)].map((m) => m[0]);
  assert.deepEqual(counts, [], `remove the frozen count: ${counts.join(', ')}`);
});

test('the quickstart installs something that exists', () => {
  const installs = [...readme.matchAll(/npm i ([a-z0-9@/ -]+)/g)].flatMap((m) =>
    m[1]!.trim().split(/\s+/),
  );
  const real = new Set(published());
  for (const name of new Set(installs)) {
    if (!name.startsWith('upnext')) continue;
    assert.ok(real.has(name), `README tells people to install ${name}, which does not exist`);
  }
});
