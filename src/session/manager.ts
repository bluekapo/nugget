import type { EventBus } from '../events/bus.js';
import type { SessionStore } from '../db/sessions.js';
import type { Session } from './types.js';
import type { PtyOptions } from './pty.js';

// Lazy import to avoid loading node-pty native module when a custom SpawnFn is provided (e.g. tests)
let _runtimeMode: 'sandbox' | 'container' = 'sandbox';
let _cachedSpawnFn: ((opts: PtyOptions) => PtyHandle) | null = null;

/** Set the runtime mode for default spawn function selection. */
export function setRuntimeMode(mode: 'sandbox' | 'container'): void {
  if (mode !== _runtimeMode) {
    _runtimeMode = mode;
    _cachedSpawnFn = null; // Clear cache so next lazy-load picks the right function
  }
}

async function getDefaultSpawnFn(): Promise<(opts: PtyOptions) => PtyHandle> {
  if (!_cachedSpawnFn) {
    const mod = await import('./pty.js');
    _cachedSpawnFn = (_runtimeMode === 'container'
      ? mod.spawnDockerContainer
      : mod.spawnDockerSandbox) as unknown as (opts: PtyOptions) => PtyHandle;
  }
  return _cachedSpawnFn;
}

/** Minimal interface for a PTY process -- enables dependency injection for testing. */
export interface PtyHandle {
  pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  kill(): void;
  resize?(cols: number, rows: number): void;
  pause?(): void;   // Flow control: pause PTY output (CAPT-05)
  resume?(): void;  // Flow control: resume PTY output (CAPT-05)
}

/** Function signature for spawning a PTY. */
export type SpawnFn = (opts: PtyOptions) => PtyHandle;

interface ActivePty {
  pty: PtyHandle;
  disposables: Array<{ dispose(): void }>;
}

export class SessionManager {
  private activePtys: Map<string, ActivePty> = new Map();
  private spawnFn: SpawnFn | null;
  private maxSessions: number;

  constructor(
    private bus: EventBus,
    private store: SessionStore,
    spawnFn?: SpawnFn,
    maxSessions: number = 3,
  ) {
    this.spawnFn = spawnFn ?? null;
    this.maxSessions = maxSessions;
  }

  async start(name: string, opts?: { cols?: number; rows?: number; containerName?: string }): Promise<Session> {
    // Check MAX_SESSIONS limit
    if (this.activePtys.size >= this.maxSessions) {
      throw new Error(`Maximum ${this.maxSessions} concurrent sessions reached`);
    }

    // Check for existing session
    const existing = this.store.findByName(name);
    if (existing) {
      if (existing.status === 'stopped' || existing.status === 'stopping') {
        // Remove stale record so the name can be reused.
        // 'stopping' can linger if onExit never fired (PTY kill race, process exit).
        this.store.delete(name);
      } else {
        throw new Error(`Session "${name}" already exists (status: ${existing.status})`);
      }
    }

    // Create session in store (status: 'starting')
    this.store.create(name);

    // Spawn PTY (lazy-load default spawnFn if none was provided)
    const spawnFn = this.spawnFn ?? await getDefaultSpawnFn();
    const ptyProcess = spawnFn({ name, containerName: opts?.containerName, cols: opts?.cols, rows: opts?.rows });

    const disposables: Array<{ dispose(): void }> = [];

    // Wire onData -> bus 'session:output'
    const dataDisposable = ptyProcess.onData((data: string) => {
      this.bus.emit('session:output', name, data);
    });
    disposables.push(dataDisposable);

    // Wire onExit -> store.updateStatus('stopped') + bus 'session:exit'
    const exitDisposable = ptyProcess.onExit(({ exitCode }) => {
      this.store.updateStatus(name, 'stopped');
      this.bus.emit('session:exit', name, exitCode);

      // Cleanup disposables
      for (const d of disposables) {
        d.dispose();
      }
      this.activePtys.delete(name);
    });
    disposables.push(exitDisposable);

    // Store PTY handle
    this.activePtys.set(name, { pty: ptyProcess, disposables });

    // Update store: status 'running', pid
    this.store.updateStatus(name, 'running');
    this.store.updatePid(name, ptyProcess.pid);

    // Emit started event
    this.bus.emit('session:started', name);

    // Return session from store
    const session = this.store.findByName(name);
    if (!session) {
      throw new Error(`Session "${name}" not found after creation`);
    }
    return session;
  }

  async stop(name: string): Promise<void> {
    const active = this.activePtys.get(name);
    if (!active) {
      throw new Error(`Session "${name}" not found in active PTYs`);
    }

    // Update status to 'stopping'
    this.store.updateStatus(name, 'stopping');

    // Kill the PTY process -- onExit handler will do final cleanup
    active.pty.kill();
  }

  writeToSession(name: string, data: string): void {
    const active = this.activePtys.get(name);
    if (!active) {
      throw new Error(`Session "${name}" is not active`);
    }
    active.pty.write(data);
  }

  resizeSession(name: string, cols: number, rows: number): void {
    const active = this.activePtys.get(name);
    if (!active) {
      throw new Error(`Session "${name}" is not active`);
    }
    active.pty.resize?.(cols, rows);
  }

  /** Pause PTY output for a session (CAPT-05 flow control). Silently ignores non-existent/exited sessions. */
  pauseSession(name: string): void {
    const active = this.activePtys.get(name);
    if (!active) return;
    active.pty.pause?.();
  }

  /** Resume PTY output for a session (CAPT-05 flow control). Silently ignores non-existent/exited sessions. */
  resumeSession(name: string): void {
    const active = this.activePtys.get(name);
    if (!active) return;
    active.pty.resume?.();
  }

  /** Delete a session record from the store. Used by disconnect to prevent stale records. */
  deleteSession(name: string): void {
    this.store.delete(name);
  }

  getActive(): Session[] {
    return this.store.getActive();
  }
}
