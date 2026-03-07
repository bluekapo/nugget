import type { Directive } from './types.js';

export interface ExecutionResult {
  executed: boolean;
  description: string;
  waitSeconds?: number;
  escalateReason?: string;
}

export function executeDirective(
  _directive: Directive,
  _writeFn: (data: string) => void,
): ExecutionResult {
  throw new Error('not implemented');
}
