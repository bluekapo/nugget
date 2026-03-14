import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { TERMINAL_COLS, TERMINAL_ROWS } from '../terminal/constants.js';

export interface PtyOptions {
  name: string;
  cols?: number;
  rows?: number;
}

export function spawnDockerSandbox(opts: PtyOptions): IPty {
  const args = ['sandbox', 'run', opts.name];

  return pty.spawn('docker', args, {
    name: 'xterm-256color',
    cols: opts.cols ?? TERMINAL_COLS,
    rows: opts.rows ?? TERMINAL_ROWS,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
}

export function spawnDockerContainer(opts: PtyOptions): IPty {
  const args = ['start', '-ai', opts.name];

  return pty.spawn('docker', args, {
    name: 'xterm-256color',
    cols: opts.cols ?? TERMINAL_COLS,
    rows: opts.rows ?? TERMINAL_ROWS,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
}
