/**
 * Automation framework shared types for v1.2.
 *
 * Defines the directive protocol (what the orchestrator can say),
 * context packets (what the orchestrator receives), and action tracking.
 */

// --- Directive Types ---

export type DirectiveType = 'COMMAND' | 'SELECT' | 'ENTER' | 'WAIT' | 'ESCALATE';

export interface CommandDirective {
  type: 'COMMAND';
  command: string;
}

export interface SelectDirective {
  type: 'SELECT';
  option: number; // 1-based
}

export interface EnterDirective {
  type: 'ENTER';
}

export interface WaitDirective {
  type: 'WAIT';
  delaySeconds?: number;
}

export interface EscalateDirective {
  type: 'ESCALATE';
  reason: string;
}

export type Directive =
  | CommandDirective
  | SelectDirective
  | EnterDirective
  | WaitDirective
  | EscalateDirective;

// --- Context Types ---

export interface ActionEntry {
  action: string;
  outcome: string;
  timestamp: number;
}

export interface ContextPacket {
  taskDescription: string;
  workerScreen: string;
  actionLog: ActionEntry[];
  cycleNumber: number;
}

// --- Constants ---

export const DEFAULT_WAIT_SECONDS = 10;
