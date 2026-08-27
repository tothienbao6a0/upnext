import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as api from '../src/index.js';

/**
 * The README, checked against what this package actually exports.
 *
 * Written immediately after the README gained a sentence promising
 * `sendMpris` under its own name, which was not exported. Nothing failed --
 * prose cannot be typechecked, and the export list and the paragraph
 * describing it sit in different files.
 *
 * The same drift the root README has a test for, one level down.
 */

// Two levels up, not one: this runs compiled, from dist/test/.
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const exported = new Set(Object.keys(api));

test('every name the README tells you to import is exported', () => {
  const imports = [...readme.matchAll(/import\s*\{([^}]+)\}\s*from\s*'upnext-adapter-nowplaying'/g)];
  assert.ok(imports.length > 0, 'expected the README to show at least one import');

  const named = imports
    .flatMap((m) => m[1]!.split(','))
    .map((name) => name.trim())
    .filter(Boolean);

  for (const name of new Set(named)) {
    assert.ok(exported.has(name), `README imports ${name}, which this package does not export`);
  }
});

test('the platform-specific names the README offers are real', () => {
  // Named in a sentence rather than an import block, so the check above cannot
  // see them: "if you specifically want one register rather than whichever
  // this machine has".
  for (const name of ['readMediaRemote', 'sendMediaRemote', 'readMpris', 'sendMpris']) {
    if (!readme.includes(`\`${name}\``)) continue;
    assert.equal(typeof (api as Record<string, unknown>)[name], 'function', `${name} is promised`);
  }
});

test('the dispatching reads are the ones exported under the plain names', async () => {
  // The distinction the README rests on: `readNowPlaying` asks whichever
  // register this machine has, and is not an alias for the macOS one.
  assert.notEqual(
    api.readNowPlaying,
    api.readMediaRemote,
    'readNowPlaying must dispatch, not point straight at MediaRemote',
  );
  assert.notEqual(api.sendTransport, api.sendMediaRemote);
});
