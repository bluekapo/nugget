import type { EventBus } from '../events/bus.js';
import type { RemoteSessionBridge, RemoteSessionMeta } from '../telegram/bot.js';
import { logInfo } from '../logging/logger.js';

export class SessionRouter {
  private _activeSession: string | null = null;
  private sessions: Set<string> = new Set();
  private remoteSessions: Map<string, RemoteSessionBridge> = new Map();
  private remoteMetadata: Map<string, RemoteSessionMeta> = new Map();

  /** Callback to trigger a local session redraw (resize PTY -> SIGWINCH). */
  onLocalRedraw: ((name: string) => void) | null = null;

  /** Callback fired on session switch with old and new session names. */
  onSessionSwitch: ((fromSession: string | null, toSession: string) => void) | null = null;

  constructor(
    private bus: EventBus,
    private onHubUpdate: () => void,
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

    if (this._activeSession === name) {
      this._activeSession = null;
    }

    this.onHubUpdate();
  }

  /** Register a remote session (PTY lives in another process). */
  addRemote(name: string, bridge: RemoteSessionBridge, meta?: RemoteSessionMeta): void {
    this.sessions.add(name);
    this.remoteSessions.set(name, bridge);
    if (meta) {
      this.remoteMetadata.set(name, meta);
    }
  }

  /** Unregister a remote session. */
  removeRemote(name: string): void {
    this.remoteSessions.delete(name);
    this.remoteMetadata.delete(name);
    this.remove(name);
  }

  /** Get metadata for a remote session (pid, createdAt). */
  getRemoteMetadata(name: string): RemoteSessionMeta | undefined {
    return this.remoteMetadata.get(name);
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

    // Fire session switch callback (for ScreenCapture baseline reset, CLI content clear, etc.)
    this.onSessionSwitch?.(oldSession, name);

    // Trigger hub re-render
    this.onHubUpdate();

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
}
