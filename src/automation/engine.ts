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

import { TerminalEmulator } from '../terminal/emulator.js';
import { ScreenCapture } from '../terminal/capture.js';
import type { TimerProvider } from '../terminal/capture.js';
import type { EventBus } from '../events/bus.js';
import { parseDirective } from './directive-parser.js';
import { buildPrompt } from './prompt-builder.js';
import { executeDirective } from './action-executor.js';
import { ActionLog } from './action-log.js';

const RETRY_PROMPT = 'Your previous response could not be parsed as a valid directive. '
  + 'Please respond with exactly ONE of the following formats:\n'
  + '- COMMAND: <shell command>\n'
  + '- SELECT: <number>\n'
  + '- ENTER\n'
  + '- WAIT: <seconds>\n'
  + '- ESCALATE: <reason>';

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

    // Create dedicated monitors for each session
    this.workerMonitor = this.createMonitor();
    this.orchestratorMonitor = this.createMonitor();

    // Wire worker completion detection
    this.workerMonitor.capture.onPromptComplete = () => this.onWorkerIdle();

    // Subscribe to session:output events and route to correct monitor
    this.sessionOutputHandler = (sessionName: string, data: string) => {
      if (this._state === 'stopped') return;
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
    this._state = newState;
    this.bus.emit('automation:state-change', newState);
  }

  private onWorkerIdle(): void {
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

    // Send /clear to orchestrator
    this.sessionManager.writeToSession(this.config.orchestratorSession, '/clear\r');

    this.setState('clearing-orchestrator');

    // Poll orchestrator screen text every 1s for "(no content)" pattern
    this.startClearPolling();
  }

  private onClearComplete(): void {
    this.cancelClearPolling();
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

      this.setState('waiting-response');

      // Poll orchestrator screen for a parseable directive
      this.startResponsePolling();
    }, this.baseDelay);
  }

  private onResponseReady(): void {
    this.cancelResponsePolling();
    if (this._state === 'paused' || this._state === 'stopped') return;

    this.setState('executing');

    // Capture orchestrator screen and parse directive
    const orchestratorScreen = this.orchestratorMonitor?.emulator.getScreenText() ?? '';
    const directive = parseDirective(orchestratorScreen);

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
        this.setState('waiting-response');

        // Poll orchestrator screen for a parseable directive
        this.startResponsePolling();
      }, this.baseDelay);
      return;
    }

    if (!directive && this.retryAttempted) {
      this.actionLog.add('PARSE_FAILURE', orchestratorScreen.slice(0, 200));
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
    this.clearPollTimer = this.timer.setTimeout(() => {
      if (this._state !== 'clearing-orchestrator') return;

      const screenText = this.orchestratorMonitor?.emulator.getScreenText() ?? '';
      if (screenText.includes('(no content)')) {
        this.clearPollTimer = null;
        // 500ms settling delay so TUI finishes rendering before prompt text is typed
        this.timer.setTimeout(() => this.onClearComplete(), 500);
      } else {
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
    this.responsePollTimer = this.timer.setTimeout(() => {
      if (this._state !== 'waiting-response') return;

      const screenText = this.orchestratorMonitor?.emulator.getScreenText() ?? '';
      const directive = parseDirective(screenText);

      if (directive) {
        this.responsePollTimer = null;
        this.onResponseReady();
      } else {
        // Poll again in 1 second
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
