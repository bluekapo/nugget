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
 *   5. Executes directive on worker (or handles ESCALATE)
 */

import { appendFileSync } from 'node:fs';
import { TerminalEmulator } from '../terminal/emulator.js';
import { ScreenCapture } from '../terminal/capture.js';
import type { TimerProvider } from '../terminal/capture.js';
import type { EventBus } from '../events/bus.js';
import { parseDirective, parseDirectiveWithContext } from './directive-parser.js';
import { buildPrompt, buildConsultationPrompt, buildFollowUpPrompt } from './prompt-builder.js';
import { executeDirective } from './action-executor.js';
import { ActionLog } from './action-log.js';
import type { ActionEntry } from './types.js';

import { join } from 'node:path';
import { logDir } from '../config/paths.js';

const LOG_FILE = join(logDir, 'nugget.log');
function debugLog(msg: string): void {
  const ts = new Date().toISOString();
  try { appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch { /* ignore */ }
}

/** Maximum time (ms) to wait for worker "(no content)" after /clear before treating CLEAR as succeeded. */
const CLEAR_TIMEOUT_MS = 30_000;

/** Strip all ANSI escape sequences from raw PTY data. */
export function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (BEL or ST terminated, including OSC 8 hyperlinks)
    .replace(/\x1b\[\d*;?\d*[Hf]/g, '\n')            // CSI cursor position → newline (preserves Ink TUI spatial layout)
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n || '1', 10))) // CUF (Cursor Forward) → spaces (Ink TUI word spacing)
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')      // Remaining CSI sequences (colors, erase, modes)
    .replace(/\x1b[()][0-9A-Za-z]/g, '')              // Character set selection
    .replace(/\x1b[A-Za-z]/g, '')                     // Single-char escapes
    .replace(/[^\n]*\r(?!\n)/g, '');                   // Bare CR — discard everything before it on same line (terminal overwrite)
}

/** Strip Claude Code spinner lines and blank whitespace-only lines from screen text. */
export function stripSpinners(text: string): string {
  return text
    .split('\n')
    .filter(line => {
      // Strip lines matching Claude Code spinner patterns: "  · Catapulting..."
      if (/^\s*[·.]\s+\w+.*\.{3}\s*$/.test(line)) return false;
      // Strip Unicode spinner lines from Ink TUI: "✶ Scurrying...", "✽ Analyzing..."
      // Note: Do NOT add ✻ — it's used for completion markers (✻ Crunched for 1m 22s)
      if (/^\s*[✶✽✢]\s+\w+.*\.{3}\s*$/.test(line)) return false;
      // Strip lines that are just whitespace
      if (/^\s*$/.test(line)) return false;
      return true;
    })
    .join('\n');
}

/** Check if buffer has both an orchestrator response (●) and a completion marker (✻)
 *  where the marker appears AFTER the last ● line. Prevents matching echoed prompt markers
 *  that appear before (above) the orchestrator's actual response. */
function hasCompletionMarkerAfterResponse(text: string): boolean {
  const lines = text.split('\n');
  let lastBulletIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^●/.test(lines[i])) lastBulletIdx = i;
  }
  if (lastBulletIdx === -1) return false;
  for (let i = lastBulletIdx + 1; i < lines.length; i++) {
    if (/^\u273B\s+.+ for/.test(lines[i])) return true;
  }
  return false;
}

const RETRY_PROMPT = 'Your previous response could not be parsed as a valid directive. '
  + 'Please respond with exactly ONE of the following formats:\n'
  + '- COMMAND: <shell command>\n'
  + '- SELECT: <number>\n'
  + '- ENTER\n'
  + '- ESCALATE: <reason>\n'
  + '- DONE: <summary>';

const CONSULTATION_RETRY_PROMPT = 'Your previous response could not be parsed. '
  + 'Please respond with exactly YES or NO. Is the worker finished?';

export type EngineState =
  | 'stopped'
  | 'idle'
  | 'capturing-worker'
  | 'clearing-orchestrator'
  | 'clearing-worker'
  | 'prompting-orchestrator'
  | 'waiting-response'
  | 'consulting-orchestrator'
  | 'waiting-consultation'
  | 'consultation-wait'
  | 'executing'
  | 'paused';

const ENGINE_STATE_LABELS: Record<EngineState, string> = {
  'stopped': 'Stopped',
  'idle': 'Working...',
  'capturing-worker': 'Capturing worker output',
  'clearing-orchestrator': 'Preparing orchestrator',
  'clearing-worker': 'Preparing worker',
  'prompting-orchestrator': 'Prompting orchestrator',
  'waiting-response': 'Waiting for response',
  'consulting-orchestrator': 'Consulting orchestrator',
  'waiting-consultation': 'Waiting for consultation',
  'consultation-wait': 'Waiting for consultation',
  'executing': 'Executing directive',
  'paused': 'Paused',
};

/** Map raw EngineState values to human-friendly labels for display. */
export function engineStateLabel(state: string): string {
  return ENGINE_STATE_LABELS[state as EngineState] ?? state;
}

export interface EngineConfig {
  workerSession: string;
  orchestratorSession: string;
  taskDescription: string;
  timer?: TimerProvider;
  baseDelay?: number;
  idleDelay?: number;
  arrowKeyDelayMs?: number;
  maxCycles?: number;
  /** Stagnation delay in ms -- how long worker must be silent before consultation.
   *  Default: 10000 (10s). */
  stagnationDelay?: number;
  /** Consultation wait delay in ms -- how long to wait after NO response before re-checking.
   *  Default: 60000 (60s). */
  consultationWaitDelay?: number;
  /** Optional callback to trigger a PTY redraw on the orchestrator session.
   *  Used to flush stuck IPC output when the remote TUI goes idle after rendering. */
  requestOrchestratorRedraw?: () => void;
  /** PTY dimensions for the monitoring emulators.
   *  MUST match the actual PTY dimensions so cursor positioning from Ink's TUI
   *  renders correctly. Mismatch causes garbled screen captures.
   *  Default: 120 cols, 40 rows. */
  ptyCols?: number;
  ptyRows?: number;
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
  private sessionOutputHandler: ((sessionName: string, data: string) => void) | null = null;
  private retryAttempted = false;
  private readonly maxCycles: number;
  private sessionExitHandler: ((name: string, exitCode: number) => void) | null = null;
  private clearPollTimer: unknown = null;
  private responsePollTimer: unknown = null;
  private clearingBuffer = '';
  private responseBuffer = '';
  private lastResponseBufLen = 0;
  private stagnationTimer: unknown = null;
  private consultationMode = false;
  private consultationWaitTimer: unknown = null;
  private consultationRetryCount = 0;
  private idleEnteredAt = 0;
  private idleDurationMs = 0;
  private persistentContext: string[] = [];
  private workerClearBuffer = '';
  private workerClearPollTimer: unknown = null;
  private workerClearDeadlineTimer: unknown = null;
  private resetMode = false;
  private needsFullPrompt = true;
  private readonly maxConsultationRetries = 3;
  private readonly timer: TimerProvider;
  private readonly baseDelay: number;
  private readonly idleDelay: number;
  private readonly arrowKeyDelayMs: number;
  private readonly stagnationDelay: number;
  private readonly consultationWaitDelay: number;

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
    this.stagnationDelay = config.stagnationDelay ?? 10000;
    this.consultationWaitDelay = config.consultationWaitDelay ?? 60000;
  }

  get state(): EngineState {
    return this._state;
  }

  get cycle(): number {
    return this.cycleNumber;
  }

  getSerializableState(): { state: EngineState; cycleNumber: number; actionLog: ActionEntry[] } {
    return {
      state: this._state,
      cycleNumber: this.cycleNumber,
      actionLog: this.actionLog.getRecent(),
    };
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

      // Accumulate raw PTY data during waiting-response or waiting-consultation state.
      // The emulator viewport is only 40 rows — long prompts push the
      // response off-screen. Parsing the raw buffer avoids this limitation.
      if ((this._state === 'waiting-response' || this._state === 'waiting-consultation') && sessionName === this.config.orchestratorSession) {
        this.responseBuffer += data;
      }

      // Accumulate raw PTY data during clearing-worker state (worker /clear output).
      if (this._state === 'clearing-worker' && sessionName === this.config.workerSession) {
        this.workerClearBuffer += data;
      }

      // Reset stagnation timer on worker output while idle
      if (sessionName === this.config.workerSession && this._state === 'idle') {
        this.resetStagnationTimer();
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
    this.cancelClearPolling();
    this.cancelResponsePolling();
    this.cancelStagnationTimer();
    this.cancelConsultationWaitTimer();
    this.cancelWorkerClearPolling();

    // Reset buffers
    this.clearingBuffer = '';
    this.responseBuffer = '';
    this.workerClearBuffer = '';
    this.resetMode = false;
    this.needsFullPrompt = true;

    this.setState('stopped');
  }

  pause(): void {
    if (this._state === 'stopped') return;
    this.cancelClearPolling();
    this.cancelResponsePolling();
    this.cancelStagnationTimer();
    this.cancelConsultationWaitTimer();
    this.cancelWorkerClearPolling();
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
    const cols = this.config.ptyCols ?? 120;
    const rows = this.config.ptyRows ?? 40;
    debugLog(`[createMonitor] creating emulator with dims=${cols}x${rows}`);
    const emulator = new TerminalEmulator(cols, rows);
    const capture = new ScreenCapture(emulator, () => {}, {
      timer: this.timer,
      baseDelay: this.baseDelay,
      idleDelay: this.idleDelay,
    });
    return { emulator, capture };
  }

  private setState(newState: EngineState): void {
    const oldState = this._state;
    debugLog(`[setState] ${oldState} -> ${newState}`);
    this._state = newState;

    // Cancel stagnation timer when leaving idle
    if (oldState === 'idle' && newState !== 'idle') {
      this.cancelStagnationTimer();
    }

    // Start stagnation timer when entering idle, record timestamp
    if (newState === 'idle' && oldState !== 'idle') {
      this.idleEnteredAt = this.timer.now();
      this.startStagnationTimer();
    }

    this.bus.emit('automation:state-change', newState);
  }

  private onWorkerIdle(): void {
    debugLog(`[onWorkerIdle] state=${this._state} cycle=${this.cycleNumber}`);
    if (this._state !== 'idle') return;

    // SAF-01: Cycle limit guard
    if (this.cycleNumber >= this.maxCycles) {
      this.bus.emit('automation:error', `Cycle limit reached (${this.maxCycles})`);
      this.stop();
      return;
    }

    // SAF-02: Reset retry flag each cycle
    this.retryAttempted = false;

    // Normal directive cycle (not consultation)
    this.consultationMode = false;
    this.consultationRetryCount = 0;

    this.setState('capturing-worker');

    // Capture worker screen text FIRST — this shows the result of the previous command.
    // Must happen before updateLastOutcome so we use the fresh screen, not the stale
    // one from the previous cycle's capture (which was taken before that command was sent).
    if (this.workerMonitor) {
      const rawScreen = this.workerMonitor.emulator.getScreenText();
      this.workerScreenText = stripSpinners(rawScreen);

      // Debug: dump buffer diagnostics
      const diag = this.workerMonitor.emulator.getBufferDiagnostics();
      debugLog(`[onWorkerIdle] BUFFER DIAG: bufLen=${diag.bufferLength} baseY=${diag.baseY} viewportY=${diag.viewportY} cursor=(${diag.cursorX},${diag.cursorY}) dims=${diag.cols}x${diag.rows} scrollback=${diag.scrollbackLines}`);
      debugLog(`[onWorkerIdle] SCROLLBACK TAIL (last ${diag.scrollbackTail.length} lines):\n${diag.scrollbackTail.join('\n')}`);
      debugLog(`[onWorkerIdle] VIEWPORT (${diag.viewportLines.length} lines):\n${diag.viewportLines.join('\n')}`);
      debugLog(`[onWorkerIdle] RAW getScreenText (${rawScreen.length} chars):\n${rawScreen}`);
      debugLog(`[onWorkerIdle] AFTER stripSpinners (${this.workerScreenText.length} chars):\n${this.workerScreenText}`);

      // Log scrollback text — Ink doesn't touch scrollback, so it's clean
      const scrollback = this.workerMonitor.emulator.getScrollbackText();
      debugLog(`[onWorkerIdle] SCROLLBACK TEXT (${scrollback.length} chars, last 2000):\n${scrollback.slice(-2000)}`);
    }

    // NOW retroactively update previous cycle's outcome with the fresh screen content.
    // Use scrollback + viewport for a fuller picture of the worker's response.
    if (this.workerMonitor) {
      const scrollback = this.workerMonitor.emulator.getScrollbackText();
      const fullText = scrollback ? scrollback + '\n' + this.workerScreenText : this.workerScreenText;
      this.actionLog.updateLastOutcome(fullText.slice(-1000));
    } else {
      this.actionLog.updateLastOutcome(this.workerScreenText.slice(-1000));
    }

    // Follow-up prompt path: skip /clear and send short prompt directly
    if (!this.needsFullPrompt) {
      debugLog(`[onWorkerIdle] follow-up path (needsFullPrompt=false), skipping /clear`);
      this.sendFollowUpPrompt();
      return;
    }

    // Full prompt path: send /clear then mama prompt
    // Reset clearing buffer before sending /clear
    this.clearingBuffer = '';

    debugLog(`[onWorkerIdle] writing /clear to orchestrator="${this.config.orchestratorSession}"`);
    // Send /clear to orchestrator
    try {
      this.sessionManager.writeToSession(this.config.orchestratorSession, '/clear\r');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`[onWorkerIdle] write failed: ${msg}`);
      this.actionLog.add('EXEC_FAILURE', msg);
      this.bus.emit('automation:error', `Execution failed: ${msg}`);
      this.stop();
      return;
    }

    this.setState('clearing-orchestrator');

    // Poll orchestrator screen text every 1s for "(no content)" pattern
    this.startClearPolling();
  }

  private onClearComplete(): void {
    debugLog(`[onClearComplete] state=${this._state} resetMode=${this.resetMode}`);
    this.cancelClearPolling();
    this.clearingBuffer = '';
    if (this._state !== 'clearing-orchestrator') return;

    // If RESET-triggered, update action outcome and clear reset flag
    if (this.resetMode) {
      this.resetMode = false;
      this.actionLog.updateLastOutcome('Orchestrator reset, re-sending full prompt');
    }

    this.setState('prompting-orchestrator');

    // Build prompt with context
    this.cycleNumber++;
    const prompt = buildPrompt({
      taskDescription: this.config.taskDescription,
      workerScreen: this.workerScreenText,
      actionLog: this.actionLog.getCompressed(),
      cycleNumber: this.cycleNumber,
      persistentContext: this.persistentContext,
    });

    debugLog(`[onClearComplete] PROMPT BEING SENT (${prompt.length} chars):\n${prompt}`);

    // Send prompt text to orchestrator (without Enter).
    // The Enter keystroke is sent after a short delay so the TUI (Ink raw mode)
    // has time to process the multiline text before the submission signal arrives.
    try {
      this.sessionManager.writeToSession(this.config.orchestratorSession, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`[onClearComplete] write failed: ${msg}`);
      this.actionLog.add('EXEC_FAILURE', msg);
      this.bus.emit('automation:error', `Execution failed: ${msg}`);
      this.stop();
      return;
    }

    this.timer.setTimeout(() => {
      if (this._state !== 'prompting-orchestrator') return;

      try {
        this.sessionManager.writeToSession(this.config.orchestratorSession, '\r');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[onClearComplete] Enter write failed: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', msg);
        this.bus.emit('automation:error', `Execution failed: ${msg}`);
        this.stop();
        return;
      }

      // Reset orchestrator monitor for clean screen reads
      if (this.orchestratorMonitor) {
        this.orchestratorMonitor.capture.resetBaseline();
        this.orchestratorMonitor.capture.markInputSent();
      }

      this.responseBuffer = '';
      this.lastResponseBufLen = 0;
      this.needsFullPrompt = false;
      this.setState('waiting-response');

      // Poll orchestrator screen for a parseable directive
      this.startResponsePolling();
    }, this.baseDelay);
  }

  /** Send a short follow-up prompt directly (no /clear), used for cycles 2+. */
  private sendFollowUpPrompt(): void {
    this.setState('prompting-orchestrator');

    this.cycleNumber++;
    const recentActions = this.actionLog.getRecent(1);
    const prompt = buildFollowUpPrompt({
      workerScreen: this.workerScreenText,
      lastAction: recentActions.length > 0 ? recentActions[0] : null,
      cycleNumber: this.cycleNumber,
    });

    debugLog(`[sendFollowUpPrompt] FOLLOW-UP PROMPT (${prompt.length} chars):\n${prompt}`);

    try {
      this.sessionManager.writeToSession(this.config.orchestratorSession, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`[sendFollowUpPrompt] write failed: ${msg}`);
      this.actionLog.add('EXEC_FAILURE', msg);
      this.bus.emit('automation:error', `Execution failed: ${msg}`);
      this.stop();
      return;
    }

    this.timer.setTimeout(() => {
      if (this._state !== 'prompting-orchestrator') return;

      try {
        this.sessionManager.writeToSession(this.config.orchestratorSession, '\r');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[sendFollowUpPrompt] Enter write failed: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', msg);
        this.bus.emit('automation:error', `Execution failed: ${msg}`);
        this.stop();
        return;
      }

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

    // Parse directive and context from raw PTY buffer (emulator viewport is too small, Ink redraws in-place)
    // stripSpinners removes Unicode spinner lines (✶, ✽, ✢) that interleave between COMMAND and its continuation
    const stripped = stripSpinners(stripAnsi(this.responseBuffer));
    debugLog(`[onResponseReady] bufLen=${this.responseBuffer.length} strippedLen=${stripped.length} tail300=${JSON.stringify(stripped.slice(-300))}`);
    const parseResult = parseDirectiveWithContext(stripped);
    const directive = parseResult.directive;

    // Accumulate persistent context if present (before handling directive)
    if (parseResult.context !== null) {
      this.persistentContext.push(parseResult.context);
    }

    // SAF-02: Parse retry logic
    if (!directive && !this.retryAttempted) {
      this.retryAttempted = true;
      this.bus.emit('automation:warning', 'Failed to parse directive from orchestrator response, retrying');

      // Send clarifying re-prompt text (without Enter), then submit after delay
      try {
        this.sessionManager.writeToSession(this.config.orchestratorSession, RETRY_PROMPT);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[onResponseReady] retry write failed: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', msg);
        this.bus.emit('automation:error', `Execution failed: ${msg}`);
        this.stop();
        return;
      }
      this.setState('prompting-orchestrator');

      this.timer.setTimeout(() => {
        if (this._state !== 'prompting-orchestrator') return;

        try {
          this.sessionManager.writeToSession(this.config.orchestratorSession, '\r');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          debugLog(`[onResponseReady] retry Enter write failed: ${msg}`);
          this.actionLog.add('EXEC_FAILURE', msg);
          this.bus.emit('automation:error', `Execution failed: ${msg}`);
          this.stop();
          return;
        }

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
      debugLog(`[onResponseReady] parse failed after retry — retrying again`);
      this.retryAttempted = false;  // Reset so the retry-prompt block above fires again
      this.actionLog.add('PARSE_FAILURE', stripped.slice(0, 200));
      this.bus.emit('automation:warning', 'Failed to parse orchestrator response, retrying again');

      try {
        this.sessionManager.writeToSession(this.config.orchestratorSession, RETRY_PROMPT);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[onResponseReady] unlimited retry write failed: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', msg);
        this.bus.emit('automation:error', `Execution failed: ${msg}`);
        this.stop();
        return;
      }
      this.setState('prompting-orchestrator');

      this.timer.setTimeout(() => {
        if (this._state !== 'prompting-orchestrator') return;
        try {
          this.sessionManager.writeToSession(this.config.orchestratorSession, '\r');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          debugLog(`[onResponseReady] unlimited retry Enter failed: ${msg}`);
          this.actionLog.add('EXEC_FAILURE', msg);
          this.bus.emit('automation:error', `Execution failed: ${msg}`);
          this.stop();
          return;
        }
        if (this.orchestratorMonitor) {
          this.orchestratorMonitor.capture.resetBaseline();
          this.orchestratorMonitor.capture.markInputSent();
        }
        this.responseBuffer = '';
        this.lastResponseBufLen = 0;
        this.setState('waiting-response');
        this.startResponsePolling();
      }, this.baseDelay);
      return;
    }

    // Explicit null guard for TypeScript narrowing (all null paths returned above)
    if (!directive) return;

    // Handle CLEAR directive: send /clear to worker, poll for (no content)
    if (directive.type === 'CLEAR') {
      this.actionLog.add('CLEAR', '(clearing worker)');
      this.workerClearBuffer = '';
      try {
        this.sessionManager.writeToSession(this.config.workerSession, '/clear\r');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[onResponseReady] CLEAR write failed: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', msg);
        this.bus.emit('automation:error', `Execution failed: ${msg}`);
        this.stop();
        return;
      }
      this.setState('clearing-worker');
      this.startWorkerClearPolling();
      return;
    }

    // Handle RESET directive: clear orchestrator, re-send full prompt
    if (directive.type === 'RESET') {
      this.actionLog.add('RESET', '(resetting orchestrator)');
      this.clearingBuffer = '';
      try {
        this.sessionManager.writeToSession(this.config.orchestratorSession, '/clear\r');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[onResponseReady] RESET write failed: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', msg);
        this.bus.emit('automation:error', `Execution failed: ${msg}`);
        this.stop();
        return;
      }
      this.resetMode = true;
      this.needsFullPrompt = true;
      this.setState('clearing-orchestrator');
      this.startClearPolling();
      return;
    }

    // Handle based on directive type
    if (directive.type === 'SELECT') {
      // SELECT uses async arrow-down sequence with delays
      this.sendSelect(directive.option);
      return;
    }

    // Use executeDirective for COMMAND, ENTER, ESCALATE, DONE
    const writeFn = (data: string) => {
      this.sessionManager.writeToSession(this.config.workerSession, data);
    };
    let result: ReturnType<typeof executeDirective>;
    try {
      result = executeDirective(directive, writeFn);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`[onResponseReady] executeDirective failed: ${msg}`);
      this.actionLog.add('EXEC_FAILURE', msg);
      this.bus.emit('automation:error', `Execution failed: ${msg}`);
      this.stop();
      return;
    }

    if (directive.type === 'DONE') {
      this.actionLog.add(result.description, result.doneSummary ?? 'done');
      this.bus.emit('automation:done', result.doneSummary ?? directive.summary);
      // Remove session exit handler BEFORE stop() to prevent race condition
      if (this.sessionExitHandler) {
        this.bus.off('session:exit', this.sessionExitHandler);
        this.sessionExitHandler = null;
      }
      this.stop();
      return;
    }

    if (directive.type === 'ESCALATE') {
      this.actionLog.add(result.description, result.escalateReason ?? 'escalated');
      this.bus.emit('automation:escalation', result.escalateReason ?? directive.reason);
      this.setState('paused');
      return;
    }

    // COMMAND or ENTER -- log and complete cycle
    this.actionLog.add(result.description, '(awaiting result)');
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
        try {
          this.sessionManager.writeToSession(this.config.workerSession, '\x1b[B');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          debugLog(`[sendSelect] arrow-down write failed: ${msg}`);
          this.actionLog.add('EXEC_FAILURE', msg);
          this.bus.emit('automation:error', `Execution failed: ${msg}`);
          this.stop();
          return;
        }
        sent++;
        this.timer.setTimeout(() => sendNext(), this.arrowKeyDelayMs);
      } else {
        // Send Enter
        try {
          this.sessionManager.writeToSession(this.config.workerSession, '\r');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          debugLog(`[sendSelect] Enter write failed: ${msg}`);
          this.actionLog.add('EXEC_FAILURE', msg);
          this.bus.emit('automation:error', `Execution failed: ${msg}`);
          this.stop();
          return;
        }

        // Log and complete cycle
        const description = `SELECT: ${option}`;
        this.actionLog.add(description, '(awaiting result)');
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
      try {
        this.sessionManager.writeToSession(this.config.workerSession, '\x1b[B');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[sendSelect] first arrow-down write failed: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', msg);
        this.bus.emit('automation:error', `Execution failed: ${msg}`);
        this.stop();
        return;
      }
      sent++;
      this.timer.setTimeout(() => sendNext(), this.arrowKeyDelayMs);
    } else {
      // SELECT: 1 -- no arrow-downs, just Enter
      try {
        this.sessionManager.writeToSession(this.config.workerSession, '\r');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[sendSelect] SELECT:1 Enter write failed: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', msg);
        this.bus.emit('automation:error', `Execution failed: ${msg}`);
        this.stop();
        return;
      }
      const description = `SELECT: ${option}`;
      this.actionLog.add(description, '(awaiting result)');
      this.bus.emit('automation:cycle-complete', this.cycleNumber, description);
      if (this.workerMonitor) {
        this.workerMonitor.capture.resetBaseline();
        this.workerMonitor.capture.markInputSent();
        this.workerMonitor.capture.onPromptComplete = () => this.onWorkerIdle();
      }
      this.setState('idle');
    }
  }

  private startClearPolling(): void {
    this.cancelClearPolling();
    debugLog(`[startClearPolling] scheduling poll in 1000ms, bufferLen=${this.clearingBuffer.length}`);
    this.clearPollTimer = this.timer.setTimeout(() => {
      try {
        if (this._state !== 'clearing-orchestrator') {
          debugLog(`[clear-poll] SKIPPED — state changed to ${this._state}`);
          return;
        }

        // Check raw PTY buffer instead of emulator screen text.
        const stripped = this.clearingBuffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        debugLog(`[clear-poll] rawBufferLen=${this.clearingBuffer.length} strippedLen=${stripped.length} stripped=${JSON.stringify(stripped.slice(-300))}`);
        if (stripped.includes('(no content)')) {
          debugLog(`[clear-poll] FOUND "(no content)" — scheduling ${this.consultationMode ? 'onConsultationClearComplete' : 'onClearComplete'} in 500ms`);
          this.clearPollTimer = null;
          // 500ms settling delay so TUI finishes rendering before prompt text is typed
          this.timer.setTimeout(() => {
            if (this.consultationMode) {
              this.onConsultationClearComplete();
            } else {
              this.onClearComplete();
            }
          }, 500);
        } else {
          debugLog(`[clear-poll] "(no content)" NOT found — re-polling`);
          // Poll again in 1 second
          this.startClearPolling();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[clear-poll] EXCEPTION: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', `Clear polling error: ${msg}`);
        this.bus.emit('automation:error', `Clear polling failed: ${msg}`);
        this.stop();
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
    debugLog(`[startResponsePolling] scheduling poll in 1000ms (consultationMode=${this.consultationMode})`);
    this.responsePollTimer = this.timer.setTimeout(() => {
      try {
        const expectedState = this.consultationMode ? 'waiting-consultation' : 'waiting-response';
        if (this._state !== expectedState) {
          debugLog(`[response-poll] SKIPPED — state changed to ${this._state} (expected ${expectedState})`);
          return;
        }

        // Parse directives from the raw PTY buffer. The emulator viewport (40 rows)
        // is too small for the prompt echo + response, and Ink redraws in-place
        // so scrollback doesn't accumulate. The raw buffer captures everything.
        const stripped = stripSpinners(stripAnsi(this.responseBuffer));
        const { directive, context: parsedContext } = parseDirectiveWithContext(stripped);
        debugLog(`[response-poll] bufLen=${this.responseBuffer.length} strippedLen=${stripped.length} hasDirective=${!!directive} hasContext=${!!parsedContext} tail300=${JSON.stringify(stripped.slice(-300))}`);

        if (directive) {
          debugLog(`[response-poll] directive found: ${directive.type} => ${JSON.stringify(directive)}`);
          this.responsePollTimer = null;
          if (this.consultationMode) {
            this.onConsultationResponse();
          } else {
            this.onResponseReady();
          }
        } else if (hasCompletionMarkerAfterResponse(stripped)) {
          debugLog(`[response-poll] completion marker found with ● response but no directive — triggering retry`);
          this.responsePollTimer = null;
          if (this.consultationMode) {
            this.onConsultationResponse();
          } else {
            this.onResponseReady();
          }
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[response-poll] EXCEPTION: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', `Response polling error: ${msg}`);
        this.bus.emit('automation:error', `Response polling failed: ${msg}`);
        this.stop();
      }
    }, 1000);
  }

  private cancelResponsePolling(): void {
    if (this.responsePollTimer !== null) {
      this.timer.clearTimeout(this.responsePollTimer);
      this.responsePollTimer = null;
    }
  }

  private startWorkerClearPolling(): void {
    this.cancelWorkerClearPolling();
    this.scheduleWorkerClearPoll();

    // Deadline timer — fires once after CLEAR_TIMEOUT_MS to prevent indefinite stall
    this.workerClearDeadlineTimer = this.timer.setTimeout(() => {
      if (this._state !== 'clearing-worker') return;  // state guard: poll-success already ran

      debugLog(`[worker-clear-timeout] TIMEOUT after ${CLEAR_TIMEOUT_MS}ms — forcing CLEAR completion`);
      this.workerClearDeadlineTimer = null;
      this.cancelWorkerClearPolling();  // stop further polling
      this.workerClearBuffer = '';

      this.actionLog.updateLastOutcome('Worker context cleared (timeout)');
      this.bus.emit('automation:warning', `Worker CLEAR poll timed out after ${CLEAR_TIMEOUT_MS / 1000}s — continuing`);
      this.bus.emit('automation:cycle-complete', this.cycleNumber, 'CLEAR');

      // Same post-CLEAR continuation as the normal success path
      if (this.workerMonitor) {
        this.workerMonitor.capture.resetBaseline();
        this.workerMonitor.capture.requireMarker = false;
        this.workerMonitor.capture.markInputSent();
        this.workerMonitor.capture.onPromptComplete = () => this.onWorkerIdle();
      }

      this.timer.setTimeout(() => {
        this.setState('idle');
        this.cancelStagnationTimer();
        this.onWorkerIdle();
      }, 500);
    }, CLEAR_TIMEOUT_MS);
  }

  /** Schedule a single worker CLEAR poll tick (does NOT touch the deadline timer). */
  private scheduleWorkerClearPoll(): void {
    debugLog(`[startWorkerClearPolling] scheduling poll in 1000ms, bufferLen=${this.workerClearBuffer.length}`);
    this.workerClearPollTimer = this.timer.setTimeout(() => {
      try {
        if (this._state !== 'clearing-worker') {
          debugLog(`[worker-clear-poll] SKIPPED — state changed to ${this._state}`);
          return;
        }

        const stripped = this.workerClearBuffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        debugLog(`[worker-clear-poll] rawBufferLen=${this.workerClearBuffer.length} strippedLen=${stripped.length}`);
        if (stripped.includes('(no content)')) {
          debugLog(`[worker-clear-poll] FOUND "(no content)" — completing CLEAR`);
          this.cancelWorkerClearPolling();  // cancel both poll timer and deadline timer
          this.workerClearBuffer = '';
          this.actionLog.updateLastOutcome('Worker context cleared');
          this.bus.emit('automation:cycle-complete', this.cycleNumber, 'CLEAR');

          // Reset worker monitor for next cycle
          if (this.workerMonitor) {
            this.workerMonitor.capture.resetBaseline();
            this.workerMonitor.capture.requireMarker = false;  // /clear has no ✻ marker
            this.workerMonitor.capture.markInputSent();
            this.workerMonitor.capture.onPromptComplete = () => this.onWorkerIdle();
          }

          // 500ms settling delay so TUI finishes rendering before next cycle
          // (matches orchestrator startClearPolling pattern)
          // /clear produces no completion marker, so onPromptComplete never fires.
          // We call onWorkerIdle() directly to continue the automation cycle.
          this.timer.setTimeout(() => {
            this.setState('idle');
            this.cancelStagnationTimer();
            this.onWorkerIdle();
          }, 500);
        } else {
          debugLog(`[worker-clear-poll] "(no content)" NOT found — re-polling`);
          this.scheduleWorkerClearPoll();  // re-poll without resetting deadline timer
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[worker-clear-poll] EXCEPTION: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', `Worker clear polling error: ${msg}`);
        this.bus.emit('automation:error', `Worker clear polling failed: ${msg}`);
        this.stop();
      }
    }, 1000);
  }

  private cancelWorkerClearPolling(): void {
    if (this.workerClearPollTimer !== null) {
      this.timer.clearTimeout(this.workerClearPollTimer);
      this.workerClearPollTimer = null;
    }
    if (this.workerClearDeadlineTimer !== null) {
      this.timer.clearTimeout(this.workerClearDeadlineTimer);
      this.workerClearDeadlineTimer = null;
    }
  }

  // --- Stagnation detection and consultation flow ---

  private startStagnationTimer(): void {
    this.cancelStagnationTimer();
    debugLog(`[startStagnationTimer] scheduling in ${this.stagnationDelay}ms`);
    this.stagnationTimer = this.timer.setTimeout(() => {
      this.stagnationTimer = null;
      this.onWorkerStagnation();
    }, this.stagnationDelay);
  }

  private cancelStagnationTimer(): void {
    if (this.stagnationTimer !== null) {
      this.timer.clearTimeout(this.stagnationTimer);
      this.stagnationTimer = null;
    }
  }

  private resetStagnationTimer(): void {
    if (this._state !== 'idle') return;
    debugLog(`[resetStagnationTimer] worker output received, resetting`);
    this.startStagnationTimer();
  }

  private onWorkerStagnation(): void {
    debugLog(`[onWorkerStagnation] state=${this._state}`);
    if (this._state !== 'idle') return;

    // Enter consultation mode -- re-arm full prompt since consultation clears orchestrator context
    this.consultationMode = true;
    this.needsFullPrompt = true;
    this.retryAttempted = false;

    this.setState('consulting-orchestrator');

    // Calculate idle duration for consultation context
    this.idleDurationMs = this.timer.now() - this.idleEnteredAt;

    // Capture worker screen text for the consultation prompt (with spinner stripping)
    if (this.workerMonitor) {
      const rawScreen = this.workerMonitor.emulator.getScreenText();
      this.workerScreenText = stripSpinners(rawScreen);

      // Debug: dump buffer diagnostics for consultation capture
      const diag = this.workerMonitor.emulator.getBufferDiagnostics();
      debugLog(`[onWorkerStagnation] BUFFER DIAG: bufLen=${diag.bufferLength} baseY=${diag.baseY} viewportY=${diag.viewportY} cursor=(${diag.cursorX},${diag.cursorY}) dims=${diag.cols}x${diag.rows} scrollback=${diag.scrollbackLines}`);
      debugLog(`[onWorkerStagnation] SCROLLBACK TAIL (last ${diag.scrollbackTail.length} lines):\n${diag.scrollbackTail.join('\n')}`);
      debugLog(`[onWorkerStagnation] VIEWPORT (${diag.viewportLines.length} lines):\n${diag.viewportLines.join('\n')}`);
      debugLog(`[onWorkerStagnation] RAW getScreenText (${rawScreen.length} chars):\n${rawScreen}`);
      debugLog(`[onWorkerStagnation] AFTER stripSpinners (${this.workerScreenText.length} chars):\n${this.workerScreenText}`);

      // Log scrollback text — clean content not affected by Ink's cursor rendering
      const scrollback = this.workerMonitor.emulator.getScrollbackText();
      debugLog(`[onWorkerStagnation] SCROLLBACK TEXT (${scrollback.length} chars, last 2000):\n${scrollback.slice(-2000)}`);

      // Update action log with fresh screen content so consultation prompt is accurate
      const fullText = scrollback ? scrollback + '\n' + this.workerScreenText : this.workerScreenText;
      this.actionLog.updateLastOutcome(fullText.slice(-1000));
    } else {
      this.actionLog.updateLastOutcome(this.workerScreenText.slice(-1000));
    }

    // Reset clearing buffer before sending /clear
    this.clearingBuffer = '';

    debugLog(`[onWorkerStagnation] writing /clear to orchestrator="${this.config.orchestratorSession}"`);
    try {
      this.sessionManager.writeToSession(this.config.orchestratorSession, '/clear\r');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`[onWorkerStagnation] write failed: ${msg}`);
      this.actionLog.add('EXEC_FAILURE', msg);
      this.bus.emit('automation:error', `Execution failed: ${msg}`);
      this.stop();
      return;
    }

    this.setState('clearing-orchestrator');

    // Poll orchestrator for "(no content)" pattern
    this.startClearPolling();
  }

  private onConsultationClearComplete(): void {
    debugLog(`[onConsultationClearComplete] state=${this._state}`);
    this.cancelClearPolling();
    this.clearingBuffer = '';
    if (this._state !== 'clearing-orchestrator') return;

    this.setState('consulting-orchestrator');

    // Build consultation prompt (YES/NO question, not directive prompt)
    const prompt = buildConsultationPrompt({
      taskDescription: this.config.taskDescription,
      workerScreen: this.workerScreenText,
      actionLog: this.actionLog.getCompressed(),
      cycleNumber: this.cycleNumber,
      idleDurationMs: this.idleDurationMs,
    });

    debugLog(`[onConsultationClearComplete] CONSULTATION PROMPT BEING SENT (${prompt.length} chars):\n${prompt}`);

    // Send prompt text to orchestrator (without Enter)
    try {
      this.sessionManager.writeToSession(this.config.orchestratorSession, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`[onConsultationClearComplete] write failed: ${msg}`);
      this.actionLog.add('EXEC_FAILURE', msg);
      this.bus.emit('automation:error', `Execution failed: ${msg}`);
      this.stop();
      return;
    }

    this.timer.setTimeout(() => {
      if (this._state !== 'consulting-orchestrator') return;

      try {
        this.sessionManager.writeToSession(this.config.orchestratorSession, '\r');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[onConsultationClearComplete] Enter write failed: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', msg);
        this.bus.emit('automation:error', `Execution failed: ${msg}`);
        this.stop();
        return;
      }

      // Reset orchestrator monitor for clean screen reads
      if (this.orchestratorMonitor) {
        this.orchestratorMonitor.capture.resetBaseline();
        this.orchestratorMonitor.capture.markInputSent();
      }

      this.responseBuffer = '';
      this.lastResponseBufLen = 0;
      this.setState('waiting-consultation');

      // Poll orchestrator for YES/NO response
      this.startResponsePolling();
    }, this.baseDelay);
  }

  private onConsultationResponse(): void {
    debugLog(`[onConsultationResponse] state=${this._state}`);
    this.cancelResponsePolling();
    if (this._state === 'paused' || this._state === 'stopped') return;

    // Parse directive from raw PTY buffer
    const stripped = stripAnsi(this.responseBuffer);
    const directive = parseDirective(stripped);

    if (directive && directive.type === 'YES') {
      debugLog(`[onConsultationResponse] YES — triggering normal cycle via onWorkerIdle`);
      // Orchestrator confirms worker is done — start a normal directive cycle
      this.consultationMode = false;
      this.consultationRetryCount = 0;
      this.retryAttempted = false;
      this.setState('idle');
      this.onWorkerIdle();
      return;
    }

    if (directive && directive.type === 'NO') {
      this.consultationRetryCount++;
      debugLog(`[onConsultationResponse] NO #${this.consultationRetryCount} — waiting ${this.consultationWaitDelay}ms then re-checking`);

      // After maxConsultationRetries consecutive NOs, force a normal directive cycle
      if (this.consultationRetryCount >= this.maxConsultationRetries) {
        debugLog(`[onConsultationResponse] ${this.consultationRetryCount} consecutive NOs — forcing normal directive cycle`);
        this.consultationRetryCount = 0;
        this.consultationMode = false;
        this.retryAttempted = false;
        this.setState('idle');
        this.onWorkerIdle();
        return;
      }

      this.setState('consultation-wait');

      // Re-arm worker completion detection during wait so a completion
      // marker can cancel the wait and start a normal cycle
      if (this.workerMonitor) {
        this.workerMonitor.capture.onPromptComplete = () => {
          if (this._state !== 'consultation-wait') return;
          debugLog(`[consultation-wait] worker completed during wait — exiting consultation`);
          this.cancelConsultationWaitTimer();
          this.consultationMode = false;
          this.retryAttempted = false;
          this.setState('idle');
          this.onWorkerIdle();
        };
      }

      // Start wait timer — re-check after delay
      this.consultationWaitTimer = this.timer.setTimeout(() => {
        this.consultationWaitTimer = null;
        if (this._state !== 'consultation-wait') return;

        debugLog(`[consultation-wait] timer expired — re-checking worker stagnation`);
        // Check if worker produced a completion marker during the wait.
        // NOTE: We only check for the completion marker (✻ Crunched for Xm Ys),
        // NOT the idle prompt (❯). The idle prompt is always visible in Claude Code
        // TUI even while the worker is actively working, so checking it would
        // always false-positive into a normal cycle, treating NO as YES.
        if (this.workerMonitor) {
          const screen = this.workerMonitor.emulator.getScreenText();
          const hasMarker = screen.split('\n').some(
            line => /\u273B .+ for (?:\d+m )?\d+s/.test(line)
          );
          if (hasMarker) {
            debugLog(`[consultation-wait] completion marker detected during wait — starting normal cycle`);
            this.consultationMode = false;
            this.retryAttempted = false;
            this.setState('idle');
            this.onWorkerIdle();
            return;
          }
        }

        // Worker still stagnant — transition to idle then re-trigger consultation
        this.retryAttempted = false;
        this.setState('idle');
        this.onWorkerStagnation();
      }, this.consultationWaitDelay);
      return;
    }

    // Neither YES nor NO — retry logic
    if (!this.retryAttempted) {
      debugLog(`[onConsultationResponse] unparseable — retrying with clarifying prompt`);
      this.retryAttempted = true;

      // Send clarifying prompt
      try {
        this.sessionManager.writeToSession(this.config.orchestratorSession, CONSULTATION_RETRY_PROMPT);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[onConsultationResponse] retry write failed: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', msg);
        this.bus.emit('automation:error', `Execution failed: ${msg}`);
        this.stop();
        return;
      }
      this.setState('consulting-orchestrator');

      this.timer.setTimeout(() => {
        if (this._state !== 'consulting-orchestrator') return;

        try {
          this.sessionManager.writeToSession(this.config.orchestratorSession, '\r');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          debugLog(`[onConsultationResponse] retry Enter write failed: ${msg}`);
          this.actionLog.add('EXEC_FAILURE', msg);
          this.bus.emit('automation:error', `Execution failed: ${msg}`);
          this.stop();
          return;
        }

        if (this.orchestratorMonitor) {
          this.orchestratorMonitor.capture.resetBaseline();
          this.orchestratorMonitor.capture.markInputSent();
        }
        this.responseBuffer = '';
        this.lastResponseBufLen = 0;
        this.setState('waiting-consultation');

        this.startResponsePolling();
      }, this.baseDelay);
      return;
    }

    // Retry already attempted — retry again (unlimited)
    debugLog(`[onConsultationResponse] parse failed after retry — retrying again`);
    this.retryAttempted = false;  // Reset so the retry block above fires again
    this.bus.emit('automation:warning', 'Failed to parse consultation response, retrying again');

    try {
      this.sessionManager.writeToSession(this.config.orchestratorSession, CONSULTATION_RETRY_PROMPT);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`[onConsultationResponse] unlimited retry write failed: ${msg}`);
      this.actionLog.add('EXEC_FAILURE', msg);
      this.bus.emit('automation:error', `Execution failed: ${msg}`);
      this.stop();
      return;
    }
    this.setState('consulting-orchestrator');

    this.timer.setTimeout(() => {
      if (this._state !== 'consulting-orchestrator') return;
      try {
        this.sessionManager.writeToSession(this.config.orchestratorSession, '\r');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[onConsultationResponse] unlimited retry Enter failed: ${msg}`);
        this.actionLog.add('EXEC_FAILURE', msg);
        this.bus.emit('automation:error', `Execution failed: ${msg}`);
        this.stop();
        return;
      }
      if (this.orchestratorMonitor) {
        this.orchestratorMonitor.capture.resetBaseline();
        this.orchestratorMonitor.capture.markInputSent();
      }
      this.responseBuffer = '';
      this.lastResponseBufLen = 0;
      this.setState('waiting-consultation');
      this.startResponsePolling();
    }, this.baseDelay);
  }

  private cancelConsultationWaitTimer(): void {
    if (this.consultationWaitTimer !== null) {
      this.timer.clearTimeout(this.consultationWaitTimer);
      this.consultationWaitTimer = null;
    }
  }
}
