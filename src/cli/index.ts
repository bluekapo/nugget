#!/usr/bin/env node
import { resolve, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { packageRoot } from '../config/paths.js';

// Read version dynamically from package.json (not hardcoded)
const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));

// Resolve paths relative to the package root, not the caller's cwd
config({ path: resolve(packageRoot, '.env') });

// Resolve relative DB_PATH against package root so it works from any cwd
const rawDbPath = process.env.DB_PATH ?? './data/nugget.db';
process.env.DB_PATH = isAbsolute(rawDbPath) ? rawDbPath : resolve(packageRoot, rawDbPath);

import { Command } from 'commander';
import { startFramework } from '../index.js';
import { logInfo, logError } from '../logging/logger.js';

const program = new Command();

program
  .name('nugget')
  .description('Nugget — Run Claude Code sessions from Telegram')
  .version(pkg.version);

program
  .command('start')
  .description('Start a named Claude Code session in a Docker sandbox')
  .argument('<name>', 'Session name (e.g., my-project)')
  .action(async (name: string) => {
    try {
      logInfo(`Starting session '${name}'`);
      await startFramework(name);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Error: ${message}`);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();
