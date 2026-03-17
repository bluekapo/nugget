import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { TERMINAL_COLS, TERMINAL_ROWS } from '../terminal/constants.js';
import { logDebug, logInfo } from '../logging/logger.js';

export interface PtyOptions {
  name: string;
  containerName?: string;
  cols?: number;
  rows?: number;
}

export function spawnDockerSandbox(opts: PtyOptions): IPty {
  const args = ['sandbox', 'run', opts.containerName ?? opts.name];
  const cols = opts.cols ?? TERMINAL_COLS;
  const rows = opts.rows ?? TERMINAL_ROWS;
  logInfo(`[pty] Spawning docker sandbox: docker ${args.join(' ')} (${cols}x${rows})`);

  const p = pty.spawn('docker', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
  logDebug(`[pty] Docker sandbox spawned (pid=${p.pid})`);
  return p;
}

export function spawnDockerContainer(opts: PtyOptions): IPty {
  const args = ['start', '-ai', opts.containerName ?? opts.name];
  const cols = opts.cols ?? TERMINAL_COLS;
  const rows = opts.rows ?? TERMINAL_ROWS;
  logInfo(`[pty] Spawning docker container: docker ${args.join(' ')} (${cols}x${rows})`);

  const p = pty.spawn('docker', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
  logDebug(`[pty] Docker container spawned (pid=${p.pid})`);
  return p;
}
