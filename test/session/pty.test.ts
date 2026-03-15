/**
 * GAP: spawnDockerSandbox args construction (SESS-02)
 *
 * Tests that spawnDockerSandbox constructs the correct docker sandbox run
 * command with the correct args array: ['sandbox', 'run', name].
 *
 * Strategy: inject a fake node-pty into the CJS require cache before tsx loads
 * pty.ts, since the native node-pty binary is platform-specific.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// ---- Setup fake node-pty in CJS require cache ----

const require = createRequire(import.meta.url);

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
  };
}

const spawnCalls: SpawnCall[] = [];

const fakeResult = {
  pid: 99999,
  onData: (_cb: (data: string) => void) => ({ dispose: () => {} }),
  onExit: (_cb: (e: { exitCode: number }) => void) => ({ dispose: () => {} }),
  kill: () => {},
  write: () => {},
  resize: () => {},
};

// Resolve node-pty to its actual CJS entry point path so cache injection works
const nodePtyPath = require.resolve('node-pty');

// Inject before any pty.ts import happens
require.cache[nodePtyPath] = {
  id: nodePtyPath,
  filename: nodePtyPath,
  loaded: true,
  // biome-ignore lint: test fixture
  parent: null as any,
  children: [],
  paths: [],
  exports: {
    spawn: (cmd: string, args: string[], opts: SpawnCall['opts']): typeof fakeResult => {
      spawnCalls.push({ cmd, args, opts });
      return fakeResult;
    },
  },
// biome-ignore lint: test fixture
} as any;

// Now import pty.ts using require (tsx handles TypeScript transpilation)
// We use require() here because we need the CJS module cache injection above
// to take effect before node-pty is loaded.
const ptyModule = require('../../src/session/pty.ts') as typeof import('../../src/session/pty.js');

describe('spawnDockerContainer', () => {
  it('passes "docker" as the executable command', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerContainer({ name: 'container-test' });
    const call = spawnCalls[spawnCalls.length - 1];
    assert.ok(call, 'pty.spawn should have been called');
    assert.equal(call.cmd, 'docker', 'Command must be "docker"');
  });

  it('constructs correct args array: start -ai <name>', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerContainer({ name: 'my-container' });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.deepEqual(
      call.args,
      ['start', '-ai', 'my-container'],
      'Args must be ["start", "-ai", name]',
    );
  });

  it('uses the session name in the args array', () => {
    spawnCalls.length = 0;
    const name = 'worker-session';
    ptyModule.spawnDockerContainer({ name });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.args[2], name, 'name arg must be the session name');
  });

  it('uses xterm-256color as the terminal name', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerContainer({ name: 'term-test' });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.opts.name, 'xterm-256color', 'terminal name must be xterm-256color');
  });

  it('defaults to 120 cols when cols not specified', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerContainer({ name: 'size-test' });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.opts.cols, 120, 'default cols must be 120');
  });

  it('defaults to 40 rows when rows not specified', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerContainer({ name: 'rows-test' });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.opts.rows, 40, 'default rows must be 40');
  });

  it('respects custom cols and rows when provided', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerContainer({ name: 'custom', cols: 200, rows: 50 });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.opts.cols, 200, 'cols must match provided value');
    assert.equal(call.opts.rows, 50, 'rows must match provided value');
  });

  it('returns the PTY handle from pty.spawn', () => {
    spawnCalls.length = 0;
    const result = ptyModule.spawnDockerContainer({ name: 'return-test' });

    assert.ok(result, 'must return a PTY handle');
    assert.equal(result.pid, 99999, 'returned handle must have the pid from the spawned process');
  });
});

describe('spawnDockerSandbox', () => {
  before(() => {
    // Clear any prior calls
    spawnCalls.length = 0;
  });

  it('passes "docker" as the executable command', () => {
    ptyModule.spawnDockerSandbox({ name: 'my-session' });
    const call = spawnCalls[spawnCalls.length - 1];
    assert.ok(call, 'pty.spawn should have been called');
    assert.equal(call.cmd, 'docker', 'Command must be "docker"');
  });

  it('constructs correct args array: sandbox run <name>', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerSandbox({ name: 'my-session' });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.deepEqual(
      call.args,
      ['sandbox', 'run', 'my-session'],
      'Args must be ["sandbox", "run", name]',
    );
  });

  it('uses the session name in the args array', () => {
    spawnCalls.length = 0;
    const name = 'alpha-project';
    ptyModule.spawnDockerSandbox({ name });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.args[2], name, 'name arg must be the session name');
  });

  it('uses xterm-256color as the terminal name', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerSandbox({ name: 'term-test' });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.opts.name, 'xterm-256color', 'terminal name must be xterm-256color');
  });

  it('defaults to 120 cols when cols not specified', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerSandbox({ name: 'size-test' });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.opts.cols, 120, 'default cols must be 120');
  });

  it('defaults to 40 rows when rows not specified', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerSandbox({ name: 'rows-test' });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.opts.rows, 40, 'default rows must be 40');
  });

  it('respects custom cols and rows when provided', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerSandbox({ name: 'custom', cols: 200, rows: 50 });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.opts.cols, 200, 'cols must match provided value');
    assert.equal(call.opts.rows, 50, 'rows must match provided value');
  });

  it('returns the PTY handle from pty.spawn', () => {
    spawnCalls.length = 0;
    const result = ptyModule.spawnDockerSandbox({ name: 'return-test' });

    assert.ok(result, 'must return a PTY handle');
    assert.equal(result.pid, 99999, 'returned handle must have the pid from the spawned process');
  });
});

describe('containerName passthrough (SESS-02)', () => {
  it('spawnDockerSandbox uses containerName for docker args when provided', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerSandbox({ name: 'sess-2', containerName: 'sess' });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.args[2], 'sess', 'docker args must use containerName, not name');
  });

  it('spawnDockerContainer uses containerName for docker args when provided', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerContainer({ name: 'sess-2', containerName: 'sess' });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.args[2], 'sess', 'docker args must use containerName, not name');
  });

  it('spawnDockerSandbox falls back to name when containerName undefined', () => {
    spawnCalls.length = 0;
    ptyModule.spawnDockerSandbox({ name: 'my-name' });
    const call = spawnCalls[spawnCalls.length - 1];

    assert.equal(call.args[2], 'my-name', 'docker args must fall back to name when containerName is undefined');
  });
});
