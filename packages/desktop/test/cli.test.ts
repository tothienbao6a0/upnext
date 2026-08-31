import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { promisify } from 'node:util';

/**
 * The CLI as a user meets it: a spawned process, not an imported function.
 *
 * `--version` is read from package.json rather than written down, and this is
 * the test that makes that worth doing. The MCP server hardcoded its version
 * and spent three releases introducing itself as 0.1.0 -- a mistake worth
 * making exactly once.
 *
 * Three levels up for package.json, because this runs compiled from dist/test/.
 */

const run = promisify(execFile);
const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

test('it prints the version it actually is', async () => {
  for (const flag of ['--version', '-v', 'version']) {
    const { stdout } = await run(process.execPath, [CLI, flag]);
    assert.equal(stdout.trim(), pkg.version, `${flag} disagreed with package.json`);
  }
});

test('help mentions the flag it accepts', async () => {
  const { stdout } = await run(process.execPath, [CLI, '--help']);
  assert.match(stdout, /--version/, 'an option nobody is told about may as well not exist');
});

test('an unknown command fails rather than doing something surprising', async () => {
  await assert.rejects(
    () => run(process.execPath, [CLI, 'definitely-not-a-command']),
    (err: { code?: number }) => err.code !== 0,
    'an unrecognised command should exit non-zero',
  );
});
