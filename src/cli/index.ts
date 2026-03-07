import 'dotenv/config';
import { Command } from 'commander';
import { startFramework } from '../index.js';
import { logInfo, logError } from '../logging/logger.js';

const program = new Command();

program
  .name('ccr')
  .description('Claude Code Remote Access Framework')
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
      process.exit(1);
    }
  });

program.parse();
