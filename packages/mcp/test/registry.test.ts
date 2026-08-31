import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * `server.json` checked against the package it describes.
 *
 * The official MCP registry verifies ownership by reading `mcpName` out of the
 * *published npm tarball* and requiring it to equal the `name` in this
 * manifest. Every one of these fields is duplicated across two files that
 * nothing otherwise ties together, and the registry only tells you they
 * disagree at publish time — after the npm release is already permanent.
 *
 * Four levels up, because this runs compiled from dist/test/.
 */

const root = new URL('../../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('server.json', root), 'utf8')) as {
  name: string;
  description: string;
  version: string;
  repository: { url: string; source: string; subfolder?: string };
  packages: Array<{ registryType: string; identifier: string; version: string; transport: { type: string } }>;
};
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  mcpName?: string;
  bin?: Record<string, string>;
};

test('the manifest name is the one baked into the published package', () => {
  assert.equal(
    manifest.name,
    pkg.mcpName,
    'the registry reads mcpName from the npm tarball and demands it match',
  );
});

test('GitHub authentication requires the namespace to be the repo owner', () => {
  // Publishing under io.github.<user>/ is only permitted to that user, so a
  // mismatch here is a rejected publish rather than a wrong-looking name.
  assert.match(manifest.name, /^io\.github\.tothienbao6a0\/[a-zA-Z0-9._-]+$/);
  assert.match(manifest.repository.url, /github\.com\/tothienbao6a0\//);
});

test('both versions track the package, which moves in lockstep', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.packages[0]!.version, pkg.version);
});

test('it points at the npm package that actually holds the server', () => {
  const entry = manifest.packages[0]!;
  assert.equal(entry.identifier, pkg.name);
  assert.equal(entry.registryType, 'npm');
  assert.equal(entry.transport.type, 'stdio', 'the bin speaks stdio');
  assert.ok(pkg.bin?.['upnext-mcp'], 'stdio transport means there has to be a bin to run');
});

test('the description fits what the schema allows', () => {
  // maxLength 100 in the published schema. The package description is longer
  // than that, so these two deliberately differ and it is worth saying why.
  assert.ok(
    manifest.description.length <= 100,
    `description is ${manifest.description.length} chars, over the schema's 100`,
  );
  assert.ok(manifest.description.trim().length > 0);
});

test('the monorepo subfolder points at this package', () => {
  assert.equal(manifest.repository.subfolder, 'packages/mcp');
  assert.equal(manifest.repository.source, 'github');
});
