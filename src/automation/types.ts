/**
 * Automation framework shared types for v1.2.
 *
 * Defines the directive protocol (what the orchestrator can say),
 * context packets (what the orchestrator receives), and action tracking.
 */

// --- Directive Types ---

export type DirectiveType = 'COMMAND' | 'SELECT' | 'ENTER' | 'ESCALATE' | 'DONE' | 'YES' | 'NO' | 'CLEAR' | 'RESET';

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

export interface ClearDirective {
  type: 'CLEAR';
}

export interface ResetDirective {
  type: 'RESET';
}

export type Directive =
  | CommandDirective
  | SelectDirective
  | EnterDirective
  | EscalateDirective
  | DoneDirective
  | YesDirective
  | NoDirective
  | ClearDirective
  | ResetDirective;

/** Combined result of parsing both directive and context from the same text. */
export interface ParseResult {
  directive: Directive | null;
  context: string | null;
}

// --- Context Types ---

export interface ActionEntry {
  action: string;
  outcome: string;
  timestamp: number;
}

export interface CompressedActionLog {
  summary: string | null;  // null when entry count <= recentCount
  recent: ActionEntry[];   // most recent entries in full detail
  totalCount: number;      // total entries ever recorded
}

export interface ContextPacket {
  taskDescription: string;
  workerScreen: string;
  actionLog: ActionEntry[];
  cycleNumber: number;
  persistentContext?: string[];
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

