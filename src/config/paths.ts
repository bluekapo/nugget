import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the package root (two levels up from src/config/). */
export const packageRoot = resolve(__dirname, '..', '..');

/** Absolute path to data/log/ directory under the package root. */
export const logDir = resolve(packageRoot, 'data', 'log');

// Ensure the log directory exists on first import
try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
