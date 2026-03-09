/**
 * Automation framework shared types for v1.2.
 *
 * Defines the directive protocol (what the orchestrator can say),
 * context packets (what the orchestrator receives), and action tracking.
 */

// --- Directive Types ---

export type DirectiveType = 'COMMAND' | 'SELECT' | 'ENTER' | 'WAIT' | 'ESCALATE' | 'DONE' | 'YES' | 'NO';

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

export interface DoneDirective {
  type: 'DONE';
  summary: string;
}

export interface YesDirective {
  type: 'YES';
}

export interface NoDirective {
  type: 'NO';
}

export type Directive =
  | CommandDirective
  | SelectDirective
  | EnterDirective
  | WaitDirective
  | EscalateDirective
  | DoneDirective
  | YesDirective
  | NoDirective;

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

// --- Consultation Types ---

export interface ConsultationPacket {
  taskDescription: string;
  workerScreen: string;
  actionLog: ActionEntry[];
  cycleNumber: number;
  idleDurationMs?: number;
}

// --- Constants ---

export const DEFAULT_WAIT_SECONDS = 10;
