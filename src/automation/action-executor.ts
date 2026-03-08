import type { Directive } from './types.js';
import { DEFAULT_WAIT_SECONDS } from './types.js';

export interface ExecutionResult {
  executed: boolean;
  description: string;
  waitSeconds?: number;
  escalateReason?: string;
  doneSummary?: string;
}

export function executeDirective(
  directive: Directive,
  writeFn: (data: string) => void,
): ExecutionResult {
  switch (directive.type) {
    case 'COMMAND':
      writeFn(directive.command + '\r');
      return { executed: true, description: `COMMAND: ${directive.command}` };

    case 'SELECT':
      for (let i = 0; i < directive.option - 1; i++) {
        writeFn('\x1b[B');
      }
      writeFn('\r');
      return { executed: true, description: `SELECT: ${directive.option}` };

    case 'ENTER':
      writeFn('\r');
      return { executed: true, description: 'ENTER' };

    case 'WAIT': {
      const seconds = directive.delaySeconds ?? DEFAULT_WAIT_SECONDS;
      return { executed: true, description: `WAIT: ${seconds}s`, waitSeconds: seconds };
    }

    case 'ESCALATE':
      return {
        executed: false,
        description: `ESCALATE: ${directive.reason}`,
        escalateReason: directive.reason,
      };

    case 'DONE':
      return {
        executed: false,
        description: `DONE: ${directive.summary}`,
        doneSummary: directive.summary,
      };
  }
}
