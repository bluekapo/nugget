#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';

// Load .env from the package root, not the caller's cwd
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '..', '.env') });

import { Command } from 'commander';
import { startFramework } from '../index.js';
import { logInfo, logError } from '../logging/logger.js';

const program = new Command();

program
  .name('nugget')
  .description('Nugget — Run Claude Code sessions from Telegram')
  .version('0.1.0');

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
