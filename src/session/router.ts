import type { TelegramOutputSink } from '../telegram/output.js';
import type { MessageTracker } from '../telegram/messages.js';
import type { EventBus } from '../events/bus.js';
import type { RemoteSessionBridge } from '../telegram/bot.js';
import { logInfo, logError } from '../logging/logger.js';

export class SessionRouter {
  private _activeSession: string | null = null;
  private sessions: Set<string> = new Set();
  private remoteSessions: Map<string, RemoteSessionBridge> = new Map();

  /** Sequential promise chain for async lifecycle operations. */
  private lifecycleQueue: Promise<void> = Promise.resolve();

  /** Callback to trigger a local session redraw (resize PTY → SIGWINCH). */
  onLocalRedraw: ((name: string) => void) | null = null;

  constructor(
    private outputSink: Pick<TelegramOutputSink, 'getCurrentState' | 'restoreState' | 'clearCurrent'>,
    private bus: EventBus,
    private onHubUpdate: () => void,
    private messageTracker?: Pick<MessageTracker, 'persistAndDelete' | 'restore' | 'archive'>,
    private onBeforeSwitch?: () => void,
  ) {}

  get activeSession(): string | null {
    return this._activeSession;
  }

  add(name: string): void {
    this.sessions.add(name);
  }

  remove(name: string): void {
    if (!this.sessions.has(name)) return;
    this.sessions.delete(name);

    const isActive = this._activeSession === name;

    // Archive messages for the removed session (async, fire-and-forget).
    // For non-active sessions, use a null-state sink to avoid capturing/deleting
    // the active session's output message.
    if (this.messageTracker) {
      const sink = isActive ? this.outputSink : { getCurrentState: () => null };
      this.enqueueLifecycle(async () => {
        await this.messageTracker!.archive(name, sink);
      });
    }

    if (isActive) {
      this._activeSession = null;
    }
  }

  /** Register a remote session (PTY lives in another process). */
  addRemote(name: string, bridge: RemoteSessionBridge): void {
    this.sessions.add(name);
    this.remoteSessions.set(name, bridge);
  }

  /** Unregister a remote session. */
  removeRemote(name: string): void {
    this.remoteSessions.delete(name);
    this.remove(name);
  }

  /** Check if a session is remote (bridged via IPC). */
  isRemote(name: string): boolean {
    return this.remoteSessions.has(name);
  }

  /** Get the IPC bridge for a remote session. */
  getRemoteBridge(name: string): RemoteSessionBridge | undefined {
    return this.remoteSessions.get(name);
  }

  switchTo(name: string): void {
    if (!this.sessions.has(name)) {
      throw new Error(`Session "${name}" not found`);
    }
    if (this._activeSession === name) return; // no-op

    const oldSession = this._activeSession;

    // Set new active session
    this._activeSession = name;
    logInfo(`[switch] ${oldSession} -> ${name}`);

    // Trigger hub re-render
    this.onHubUpdate();

    // Reset diff baseline so the new session starts with a clean screen capture
    this.onBeforeSwitch?.();

    // Capture current output state SYNCHRONOUSLY before clearing.
    // persistAndDelete needs this snapshot; clearing now prevents the race
    // where new session output edits the old session's Telegram message.
    const capturedState = this.outputSink.getCurrentState();
    this.outputSink.clearCurrent();

    // Async lifecycle: persist old session's messages, restore new session's messages
    if (this.messageTracker) {
      this.enqueueLifecycle(async () => {
        // Persist and delete old session's messages (if there was an old session)
        if (oldSession !== null) {
          logInfo(`[switch] persisting messages for '${oldSession}'`);
          await this.messageTracker!.persistAndDelete(
            oldSession,
            { getCurrentState: () => capturedState },
          );
        }

        // Restore new session's messages (only if no new output has arrived)
        const result = await this.messageTracker!.restore(name);
        if (result && this.outputSink.getCurrentState() === null) {
          logInfo(`[switch] restoring messages for '${name}'`);
          this.outputSink.restoreState(result);
        }
      });
    }

    // Trigger a screen redraw so output flows immediately after switch
    const bridge = this.remoteSessions.get(name);
    if (bridge) {
      logInfo(`[switch] requesting redraw from remote '${name}'`);
      bridge.requestRedraw();
    } else {
      logInfo(`[switch] requesting local redraw for '${name}'`);
      this.onLocalRedraw?.(name);
    }
  }

  getAll(): string[] {
    return [...this.sessions];
  }

  has(name: string): boolean {
    return this.sessions.has(name);
  }

  /** Enqueue an async lifecycle operation to run sequentially. */
  private enqueueLifecycle(op: () => Promise<void>): void {
    this.lifecycleQueue = this.lifecycleQueue.then(op).catch((err) => {
      logError('[lifecycle queue]', err);
    });
  }
}
