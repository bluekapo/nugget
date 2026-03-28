import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const expectedVersion: string = pkg.version;

/**
 * Helper: run the CLI with a flag and return the last non-empty line of stdout.
 * dotenv may emit a debug banner on stdout, so we extract only the final line
 * which is Commander's version output.
 */
function runCLI(flag: string): string {
  const result = execSync(
    `node --import tsx src/cli/index.ts ${flag}`,
    { cwd: root, timeout: 10_000, encoding: 'utf8' },
  );
  const lines = result.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1].trim();
}

describe('CLI version flags', () => {
  it('nugget -v outputs the current version', () => {
    const output = runCLI('-v');
    assert.equal(output, expectedVersion, `-v should output "${expectedVersion}"`);
  });

  it('nugget --version outputs the current version', () => {
    const output = runCLI('--version');
    assert.equal(output, expectedVersion, `--version should output "${expectedVersion}"`);
  });

  it('-v and --version produce identical output', () => {
    const fromV = runCLI('-v');
    const fromVersion = runCLI('--version');
    assert.equal(fromV, fromVersion, '-v and --version should produce identical output');
  });
});
