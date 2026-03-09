import type { Directive } from './types.js';

export interface ExecutionResult {
  executed: boolean;
  description: string;
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

    case 'YES':
    case 'NO':
      throw new Error(`${directive.type} is a consultation response, not a worker action`);
  }
}
