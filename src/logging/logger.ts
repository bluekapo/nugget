/**
 * File-based logger for Nugget.
 *
 * All Nugget diagnostic output goes to a log file instead of stdout/stderr.
 * This prevents interleaving with PTY data that corrupts the terminal display.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { logDir } from '../config/paths.js';

const LOG_PATH = join(logDir, 'nugget.log');

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function fmt(...args: unknown[]): string {
  return args.map(a => {
    if (a instanceof Error) return a.stack ?? a.message;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
}

export function logInfo(...args: unknown[]): void {
  try { appendFileSync(LOG_PATH, `${ts()} INFO  ${fmt(...args)}\n`); } catch { /* ignore */ }
}

export function logWarn(...args: unknown[]): void {
  try { appendFileSync(LOG_PATH, `${ts()} WARN  ${fmt(...args)}\n`); } catch { /* ignore */ }
}

export function logError(...args: unknown[]): void {
  try { appendFileSync(LOG_PATH, `${ts()} ERROR ${fmt(...args)}\n`); } catch { /* ignore */ }
}
