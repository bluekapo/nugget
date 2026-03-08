/**
 * AutomationEngine -- the core state machine for v1.2 automation.
 *
 * Wires Phase 11 pure functions (parseDirective, buildPrompt, ActionLog) with
 * ScreenCapture and SessionManager to create the complete capture-prompt-parse-execute loop.
 *
 * Monitors worker session for idle/completion independently via dedicated ScreenCapture
 * (not Telegram display pipeline). When worker goes idle:
 *   1. Captures worker screen text
 *   2. Sends /clear to orchestrator and waits for completion
 *   3. Builds and sends prompt to orchestrator
 *   4. Parses orchestrator response as a directive
 *   5. Executes directive on worker (or handles WAIT/ESCALATE)
 */

import { appendFileSync } from 'node:fs';
import { TerminalEmulator } from '../terminal/emulator.js';
import { ScreenCapture } from '../terminal/capture.js';
import type { TimerProvider } from '../terminal/capture.js';
import type { EventBus } from '../events/bus.js';
import { parseDirective } from './directive-parser.js';
import { buildPrompt } from './prompt-builder.js';
import { executeDirective } from './action-executor.js';
import { ActionLog } from './action-log.js';

const LOG_FILE = 'nugget.log';
function debugLog(msg: string): void {
  const ts = new Date().toISOString();
  try { appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch { /* ignore */ }
}

/** Strip all ANSI escape sequences from raw PTY data. */
function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*\x07/g, '')           // OSC sequences (window title etc.)
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')   // CSI sequences (including private modes like ?2026l)
    .replace(/\x1b[()][0-9A-Za-z]/g, '')           // Character set selection
    .replace(/\x1b[A-Za-z]/g, '')                  // Single-char escapes
    .replace(/\r(?!\n)/g, '');                      // Bare CR (without LF) — cursor to start of line
}

/** Check if the buffer contains a ● line at column 0 (proof the orchestrator responded).
 *  Requires ● at start of line — echoed worker screen content is indented, so
 *  indented ● lines (from prompt echo) won't match. */
function hasOrchestratorResponse(text: string): boolean {
  return text.split('\n').some(line => /^●/.test(line));
}

/** Check if the buffer contains a ✻ completion marker at column 0 (not indented/echoed). */
function hasCompletionMarker(text: string): boolean {
  return text.split('\n').some(line => /^\u273B\s+(Crunched|Saut\u00e9ed|Mustered) for/.test(line));
}

const RETRY_PROMPT = 'Your previous response could not be parsed as a valid directive. '
  + 'Please respond with exactly ONE of the following formats:\n'
  + '- COMMAND: <shell command>\n'
  + '- SELECT: <number>\n'
  + '- ENTER\n'
  + '- WAIT: <seconds>\n'
  + '- ESCALATE: <reason>\n'
  + '- DONE: <summary>';

export type EngineState =
  | 'stopped'
  | 'idle'
  | 'capturing-worker'
  | 'clearing-orchestrator'
  | 'prompting-orchestrator'
  | 'waiting-response'
  | 'executing'
  | 'waiting'
  | 'paused';

export interface EngineConfig {
  workerSession: string;
  orchestratorSession: string;
  taskDescription: string;
  timer?: TimerProvider;
  baseDelay?: number;
  idleDelay?: number;
  arrowKeyDelayMs?: number;
  maxCycles?: number;
  /** Optional callback to trigger a PTY redraw on the orchestrator session.
   *  Used to flush stuck IPC output when the remote TUI goes idle after rendering. */
  requestOrchestratorRedraw?: () => void;
}

interface SessionMonitor {
  emulator: TerminalEmulator;
  capture: ScreenCapture;
}

/** Minimal interface for session I/O -- the engine only needs writeToSession. */
interface SessionWriter {
  writeToSession(name: string, data: string): void;
}

export class AutomationEngine {
  private _state: EngineState = 'stopped';
  private workerMonitor: SessionMonitor | null = null;
  private orchestratorMonitor: SessionMonitor | null = null;
  private readonly actionLog = new ActionLog();
  private cycleNumber = 0;
  private workerScreenText = '';
  private waitTimer: unknown = null;
  private sessionOutputHandler: ((sessionName: string, data: string) => void) | null = null;
  private retryAttempted = false;
  private readonly maxCycles: number;
  private sessionExitHandler: ((name: string, exitCode: number) => void) | null = null;
  private clearPollTimer: unknown = null;
  private responsePollTimer: unknown = null;
  private clearingBuffer = '';
  private responseBuffer = '';
  private lastResponseBufLen = 0;

  private readonly timer: TimerProvider;
  private readonly baseDelay: number;
  private readonly idleDelay: number;
  private readonly arrowKeyDelayMs: number;

  constructor(
    private readonly config: EngineConfig,
    private readonly sessionManager: SessionWriter,
    private readonly bus: EventBus,
  ) {
    this.timer = config.timer ?? {
      setTimeout: (cb, delay) => globalThis.setTimeout(cb, delay),
      clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    };
    this.baseDelay = config.baseDelay ?? 500;
    this.idleDelay = config.idleDelay ?? 5000;
    this.arrowKeyDelayMs = config.arrowKeyDelayMs ?? 50;
    this.maxCycles = config.maxCycles ?? 100;
  }

  get state(): EngineState {
    return this._state;
  }

  start(): void {
    if (this._state !== 'stopped') return;

    debugLog(`[start] worker="${this.config.workerSession}" orchestrator="${this.config.orchestratorSession}"`);

    // Create dedicated monitors for each session
    this.workerMonitor = this.createMonitor();
    this.orchestratorMonitor = this.createMonitor();

    // Wire worker completion detection
    this.workerMonitor.capture.onPromptComplete = () => this.onWorkerIdle();

    // Subscribe to session:output events and route to correct monitor
    this.sessionOutputHandler = (sessionName: string, data: string) => {
      if (this._state === 'stopped') return;

      debugLog(`[session:output] session="${sessionName}" len=${data.length} state=${this._state} isOrch=${sessionName === this.config.orchestratorSession} isWorker=${sessionName === this.config.workerSession}`);

      // Accumulate raw PTY data during clearing-orchestrator state.
      // This buffer is checked by the clear poll instead of the emulator,
      // because xterm.js processes writes asynchronously and the emulator
      // may not have the data ready when the poll fires.
      if (this._state === 'clearing-orchestrator' && sessionName === this.config.orchestratorSession) {
        this.clearingBuffer += data;
        debugLog(`[buffer-append] bufferLen=${this.clearingBuffer.length} chunkPreview=${JSON.stringify(data.slice(0, 100))}`);
      }

      // Accumulate raw PTY data during waiting-response state.
      // The emulator viewport is only 40 rows — long prompts push the
      // response off-screen. Parsing the raw buffer avoids this limitation.
      if (this._state === 'waiting-response' && sessionName === this.config.orchestratorSession) {
        this.responseBuffer += data;
      }

      if (sessionName === this.config.workerSession && this.workerMonitor) {
        this.workerMonitor.capture.onData(data);
      } else if (sessionName === this.config.orchestratorSession && this.orchestratorMonitor) {
        this.orchestratorMonitor.capture.onData(data);
      }
    };
    this.bus.on('session:output', this.sessionOutputHandler);

    this.setState('idle');

    // Kick off the first cycle immediately -- the worker is already idle
    // at its prompt when automation starts. Subsequent cycles use
    // onPromptComplete detection from workerMonitor.
    this.timer.setTimeout(() => {
      if (this._state === 'idle') {
        this.onWorkerIdle();
      }
    }, 0);

    // SAF-03: Listen for session disconnect
    this.sessionExitHandler = (name: string, _exitCode: number) => {
      if (this._state === 'stopped') return;
      if (name === this.config.workerSession || name === this.config.orchestratorSession) {
        const role = name === this.config.workerSession ? 'Worker' : 'Orchestrator';
        this.bus.emit('automation:error', `${role} session "${name}" disconnected`);
        this.stop();
      }
    };
    this.bus.on('session:exit', this.sessionExitHandler);
  }

  stop(): void {
    debugLog(`[stop] state=${this._state} (trace: ${new Error().stack?.split('\n').slice(1, 4).join(' <- ')})`);
    if (this._state === 'stopped') return;

    // Remove bus listeners
    if (this.sessionExitHandler) {
      this.bus.off('session:exit', this.sessionExitHandler);
      this.sessionExitHandler = null;
    }
    if (this.sessionOutputHandler) {
      this.bus.off('session:output', this.sessionOutputHandler);
      this.sessionOutputHandler = null;
    }

    // Dispose monitors
    if (this.workerMonitor) {
      this.workerMonitor.capture.dispose();
      this.workerMonitor.emulator.dispose();
      this.workerMonitor = null;
    }
    if (this.orchestratorMonitor) {
      this.orchestratorMonitor.capture.dispose();
      this.orchestratorMonitor.emulator.dispose();
      this.orchestratorMonitor = null;
    }

    // Clear any pending timers
    this.clearWaitTimer();
    this.cancelClearPolling();
    this.cancelResponsePolling();

    // Reset buffers
    this.clearingBuffer = '';
    this.responseBuffer = '';

    this.setState('stopped');
  }

  pause(): void {
    if (this._state === 'stopped') return;
    this.clearWaitTimer();
    this.cancelClearPolling();
    this.cancelResponsePolling();
    this.setState('paused');
  }

  resume(): void {
    if (this._state !== 'paused') return;

    // Re-arm worker completion detection
    if (this.workerMonitor) {
      this.workerMonitor.capture.onPromptComplete = () => this.onWorkerIdle();
    }

    this.setState('idle');
  }

  private createMonitor(): SessionMonitor {
    const emulator = new TerminalEmulator(120, 40);
    const capture = new ScreenCapture(emulator, () => {}, {
      timer: this.timer,
      baseDelay: this.baseDelay,
      idleDelay: this.idleDelay,
    });
    return { emulator, capture };
  }

  private setState(newState: EngineState): void {
    debugLog(`[setState] ${this._state} -> ${newState}`);
    this._state = newState;
    this.bus.emit('automation:state-change', newState);
  }

  private onWorkerIdle(): void {
    debugLog(`[onWorkerIdle] state=${this._state} cycle=${this.cycleNumber}`);
    if (this._state === 'paused' || this._state === 'stopped') return;

    // SAF-01: Cycle limit guard
    if (this.cycleNumber >= this.maxCycles) {
      this.bus.emit('automation:error', `Cycle limit reached (${this.maxCycles})`);
      this.stop();
      return;
    }

    // SAF-02: Reset retry flag each cycle
    this.retryAttempted = false;

    this.setState('capturing-worker');

    // Capture worker screen text
    if (this.workerMonitor) {
      this.workerScreenText = this.workerMonitor.emulator.getScreenText();
    }

    // Reset clearing buffer before sending /clear
    this.clearingBuffer = '';

    debugLog(`[onWorkerIdle] writing /clear to orchestrator="${this.config.orchestratorSession}"`);
    // Send /clear to orchestrator
    this.sessionManager.writeToSession(this.config.orchestratorSession, '/clear\r');

    this.setState('clearing-orchestrator');

    // Poll orchestrator screen text every 1s for "(no content)" pattern
    this.startClearPolling();
  }

  private onClearComplete(): void {
    debugLog(`[onClearComplete] state=${this._state}`);
    this.cancelClearPolling();
    this.clearingBuffer = '';
    if (this._state !== 'clearing-orchestrator') return;

    this.setState('prompting-orchestrator');

    // Build prompt with context
    this.cycleNumber++;
    const prompt = buildPrompt({
      taskDescription: this.config.taskDescription,
      workerScreen: this.workerScreenText,
      actionLog: this.actionLog.getRecent(),
      cycleNumber: this.cycleNumber,
    });

    // Send prompt text to orchestrator (without Enter).
    // The Enter keystroke is sent after a short delay so the TUI (Ink raw mode)
    // has time to process the multiline text before the submission signal arrives.
    this.sessionManager.writeToSession(this.config.orchestratorSession, prompt);

    this.timer.setTimeout(() => {
      if (this._state !== 'prompting-orchestrator') return;

      this.sessionManager.writeToSession(this.config.orchestratorSession, '\r');

      // Reset orchestrator monitor for clean screen reads
      if (this.orchestratorMonitor) {
        this.orchestratorMonitor.capture.resetBaseline();
        this.orchestratorMonitor.capture.markInputSent();
      }

      this.responseBuffer = '';
      this.lastResponseBufLen = 0;
      this.setState('waiting-response');

      // Poll orchestrator screen for a parseable directive
      this.startResponsePolling();
    }, this.baseDelay);
  }

  private onResponseReady(): void {
    debugLog(`[onResponseReady] state=${this._state}`);
    this.cancelResponsePolling();
    if (this._state === 'paused' || this._state === 'stopped') return;

    this.setState('executing');

    // Parse directive from raw PTY buffer (emulator viewport is too small, Ink redraws in-place)
    const stripped = stripAnsi(this.responseBuffer);
    debugLog(`[onResponseReady] bufLen=${this.responseBuffer.length} strippedLen=${stripped.length} tail300=${JSON.stringify(stripped.slice(-300))}`);
    const directive = parseDirective(stripped);

    // SAF-02: Parse retry logic
    if (!directive && !this.retryAttempted) {
      this.retryAttempted = true;
      this.bus.emit('automation:error', 'Failed to parse directive from orchestrator response, retrying');

      // Send clarifying re-prompt text (without Enter), then submit after delay
      this.sessionManager.writeToSession(this.config.orchestratorSession, RETRY_PROMPT);
      this.setState('prompting-orchestrator');

      this.timer.setTimeout(() => {
        if (this._state !== 'prompting-orchestrator') return;

        this.sessionManager.writeToSession(this.config.orchestratorSession, '\r');

        // Reset orchestrator monitor for clean screen reads
        if (this.orchestratorMonitor) {
          this.orchestratorMonitor.capture.resetBaseline();
          this.orchestratorMonitor.capture.markInputSent();
        }
        this.responseBuffer = '';
        this.lastResponseBufLen = 0;
        this.setState('waiting-response');

        // Poll orchestrator screen for a parseable directive
        this.startResponsePolling();
      }, this.baseDelay);
      return;
    }

    if (!directive && this.retryAttempted) {
      this.actionLog.add('PARSE_FAILURE', stripped.slice(0, 200));
      this.bus.emit('automation:escalation', 'Failed to parse orchestrator response after retry');
      this.setState('paused');
      return;
    }

    // Explicit null guard for TypeScript narrowing (all null paths returned above)
    if (!directive) return;

    // Handle based on directive type
    if (directive.type === 'SELECT') {
      // SELECT uses async arrow-down sequence with delays
      this.sendSelect(directive.option);
      return;
    }

    // Use executeDirective for COMMAND, ENTER, WAIT, ESCALATE
    const writeFn = (data: string) => {
      this.sessionManager.writeToSession(this.config.workerSession, data);
    };
    const result = executeDirective(directive, writeFn);

    if (directive.type === 'DONE') {
      this.actionLog.add(result.description, result.doneSummary ?? 'done');
      this.bus.emit('automation:done', result.doneSummary ?? directive.summary);
      this.stop();
      return;
    }

    if (directive.type === 'ESCALATE') {
      this.actionLog.add(result.description, result.escalateReason ?? 'escalated');
      this.bus.emit('automation:escalation', result.escalateReason ?? directive.reason);
      this.setState('paused');
      return;
    }

    if (directive.type === 'WAIT') {
      this.actionLog.add(result.description, `waiting ${result.waitSeconds}s`);
      this.setState('waiting');
      const waitMs = (result.waitSeconds ?? 10) * 1000;
      this.waitTimer = this.timer.setTimeout(() => {
        this.waitTimer = null;
        if (this._state === 'paused' || this._state === 'stopped') return;
        this.setState('idle');
        // Re-arm worker completion detection
        if (this.workerMonitor) {
          this.workerMonitor.capture.onPromptComplete = () => this.onWorkerIdle();
        }
      }, waitMs);
      return;
    }

    // COMMAND or ENTER -- log and complete cycle
    this.actionLog.add(result.description, this.workerScreenText.slice(0, 200));
    this.bus.emit('automation:cycle-complete', this.cycleNumber, result.description);

    // Reset worker monitor for next cycle and re-enter idle
    if (this.workerMonitor) {
      this.workerMonitor.capture.resetBaseline();
      this.workerMonitor.capture.markInputSent();
      this.workerMonitor.capture.onPromptComplete = () => this.onWorkerIdle();
    }
    this.setState('idle');
  }

  /**
   * Handle SELECT directive with async arrow-down delays.
   * Sends (option - 1) arrow-down keys with arrowKeyDelayMs between each,
   * then sends Enter.
   */
  private sendSelect(option: number): void {
    const arrowDownCount = option - 1;
    let sent = 0;

    const sendNext = (): void => {
      if (this._state === 'paused' || this._state === 'stopped') return;

      if (sent < arrowDownCount) {
        this.sessionManager.writeToSession(this.config.workerSession, '\x1b[B');
        sent++;
        this.timer.setTimeout(() => sendNext(), this.arrowKeyDelayMs);
      } else {
        // Send Enter
        this.sessionManager.writeToSession(this.config.workerSession, '\r');

        // Log and complete cycle
        const description = `SELECT: ${option}`;
        this.actionLog.add(description, this.workerScreenText.slice(0, 200));
        this.bus.emit('automation:cycle-complete', this.cycleNumber, description);

        // Reset worker monitor for next cycle
        if (this.workerMonitor) {
          this.workerMonitor.capture.resetBaseline();
          this.workerMonitor.capture.markInputSent();
          this.workerMonitor.capture.onPromptComplete = () => this.onWorkerIdle();
        }
        this.setState('idle');
      }
    };

    // Send first arrow immediately, then schedule the rest
    if (arrowDownCount > 0) {
      this.sessionManager.writeToSession(this.config.workerSession, '\x1b[B');
      sent++;
      this.timer.setTimeout(() => sendNext(), this.arrowKeyDelayMs);
    } else {
      // SELECT: 1 -- no arrow-downs, just Enter
      this.sessionManager.writeToSession(this.config.workerSession, '\r');
      const description = `SELECT: ${option}`;
      this.actionLog.add(description, this.workerScreenText.slice(0, 200));
      this.bus.emit('automation:cycle-complete', this.cycleNumber, description);
      if (this.workerMonitor) {
        this.workerMonitor.capture.resetBaseline();
        this.workerMonitor.capture.markInputSent();
        this.workerMonitor.capture.onPromptComplete = () => this.onWorkerIdle();
      }
      this.setState('idle');
    }
  }

  private clearWaitTimer(): void {
    if (this.waitTimer !== null) {
      this.timer.clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
  }

  private startClearPolling(): void {
    this.cancelClearPolling();
    debugLog(`[startClearPolling] scheduling poll in 1000ms, bufferLen=${this.clearingBuffer.length}`);
    this.clearPollTimer = this.timer.setTimeout(() => {
      if (this._state !== 'clearing-orchestrator') {
        debugLog(`[clear-poll] SKIPPED — state changed to ${this._state}`);
        return;
      }

      // Check raw PTY buffer instead of emulator screen text.
      const stripped = this.clearingBuffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      debugLog(`[clear-poll] rawBufferLen=${this.clearingBuffer.length} strippedLen=${stripped.length} stripped=${JSON.stringify(stripped.slice(-300))}`);
      if (stripped.includes('(no content)')) {
        debugLog(`[clear-poll] FOUND "(no content)" — scheduling onClearComplete in 500ms`);
        this.clearPollTimer = null;
        // 500ms settling delay so TUI finishes rendering before prompt text is typed
        this.timer.setTimeout(() => this.onClearComplete(), 500);
      } else {
        debugLog(`[clear-poll] "(no content)" NOT found — re-polling`);
        // Poll again in 1 second
        this.startClearPolling();
      }
    }, 1000);
  }

  private cancelClearPolling(): void {
    if (this.clearPollTimer !== null) {
      this.timer.clearTimeout(this.clearPollTimer);
      this.clearPollTimer = null;
    }
  }

  private startResponsePolling(): void {
    this.cancelResponsePolling();
    debugLog(`[startResponsePolling] scheduling poll in 1000ms`);
    this.responsePollTimer = this.timer.setTimeout(() => {
      if (this._state !== 'waiting-response') {
        debugLog(`[response-poll] SKIPPED — state changed to ${this._state}`);
        return;
      }

      // Parse directives from the raw PTY buffer. The emulator viewport (40 rows)
      // is too small for the prompt echo + response, and Ink redraws in-place
      // so scrollback doesn't accumulate. The raw buffer captures everything.
      const stripped = stripAnsi(this.responseBuffer);
      const directive = parseDirective(stripped);
      debugLog(`[response-poll] bufLen=${this.responseBuffer.length} strippedLen=${stripped.length} hasDirective=${!!directive} tail300=${JSON.stringify(stripped.slice(-300))}`);

      if (directive) {
        debugLog(`[response-poll] directive found: ${directive.type} => ${JSON.stringify(directive)}`);
        this.responsePollTimer = null;
        this.onResponseReady();
      } else if (hasOrchestratorResponse(stripped) && hasCompletionMarker(stripped)) {
        debugLog(`[response-poll] completion marker found with ● response but no directive — triggering retry`);
        this.responsePollTimer = null;
        this.onResponseReady();
      } else {
        // If buffer hasn't grown since last poll, request a redraw to flush
        // any output stuck in TCP/Nagle buffering or Ink's idle state.
        if (this.responseBuffer.length === this.lastResponseBufLen && this.config.requestOrchestratorRedraw) {
          debugLog(`[response-poll] buffer stale (${this.lastResponseBufLen}), requesting redraw`);
          this.config.requestOrchestratorRedraw();
        }
        this.lastResponseBufLen = this.responseBuffer.length;
        debugLog(`[response-poll] no directive yet — re-polling`);
        this.startResponsePolling();
      }
    }, 1000);
  }

  private cancelResponsePolling(): void {
    if (this.responsePollTimer !== null) {
      this.timer.clearTimeout(this.responsePollTimer);
      this.responsePollTimer = null;
    }
  }
}
