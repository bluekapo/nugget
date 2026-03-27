/**
 * File-based logger for Nugget.
 *
 * All Nugget diagnostic output goes to a log file instead of stdout/stderr.
 * This prevents interleaving with PTY data that corrupts the terminal display.
 */

import { appendFileSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { logDir } from '../config/paths.js';

const LOG_PATH = join(logDir, 'nugget.log');

/**
 * Rotate the current nugget.log to a timestamped file.
 * Called once on primary startup so each run starts with a fresh log.
 * The rotated file will be cleaned up by cleanOldLogs() based on TTL.
 */
export function rotateLog(): void {
  try {
    if (!existsSync(LOG_PATH)) return;
    // Use filesystem-safe timestamp: colons replaced with dashes
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const dest = join(logDir, `nugget-${stamp}.log`);
    renameSync(LOG_PATH, dest);
  } catch { /* ignore — fresh log will be created on first write */ }
}

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

export function logDebug(...args: unknown[]): void {
  try { appendFileSync(LOG_PATH, `${ts()} DEBUG ${fmt(...args)}\n`); } catch { /* ignore */ }
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

/**
 * Delete log files older than the given TTL from the log directory.
 * Called on primary startup to prevent unbounded log accumulation.
 */
export function cleanOldLogs(ttlHours: number): void {
  const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
  try {
    const files = readdirSync(logDir);
    let cleaned = 0;
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      const filePath = join(logDir, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filePath);
          cleaned++;
        }
      } catch { /* ignore individual file errors */ }
    }
    if (cleaned > 0) {
      logInfo(`Cleaned ${cleaned} log file(s) older than ${ttlHours}h`);
    }
  } catch { /* ignore directory read errors */ }
}
