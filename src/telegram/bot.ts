import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { createRateLimiter } from './rate-limiter.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerOnly } from './auth.js';
import { logInfo, logWarn, logError } from '../logging/logger.js';

/** In-process bot cache keyed by token (prevents duplicate bots in same process). */
const botCache = new Map<string, Bot>();

/** Compute a short hash of the bot token for the lock file name. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

/** Get the lock file path for a given token. */
function lockFilePath(token: string): string {
  return join(tmpdir(), `nugget-bot-${tokenHash(token)}.lock`);
}

/** Check if a PID is alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Max lock age before treating as stale regardless of PID liveness (handles Windows PID reuse). */
const LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Acquire a file-based lock to ensure only one process polls a given bot token.
 * Throws if another live process already holds the lock.
 * Cleans up stale locks from crashed processes automatically.
 *
 * Three-layer defense against stale locks:
 *   Layer 1: Same-PID check — idempotent re-acquire (same process is not a conflict)
 *   Layer 2: PID liveness check — dead process cleanup via process.kill(pid, 0)
 *   Layer 3: Timestamp age check — Windows PID reuse defense (lock > 24h = stale)
 *
 * Lock file format: "PID\nTIMESTAMP" (two lines).
 * Backward compat: old single-line "PID" format is parsed with timestamp = 0.
 */
function acquireBotLock(token: string): void {
  const lockPath = lockFilePath(token);

  // Phase 1: Try exclusive atomic creation (fast path — no lock exists)
  try {
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: 'wx' });
    return; // Lock acquired atomically
  } catch (err: unknown) {
    // EEXIST means lock file already exists — fall through to stale check
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err; // Unexpected filesystem error
    }
  }

  // Phase 2: Lock file exists — check if it's stale (same 3-layer defense)
  try {
    const content = readFileSync(lockPath, 'utf-8').trim();
    const lines = content.split('\n');
    const pid = parseInt(lines[0], 10);
    const timestamp = lines.length > 1 ? parseInt(lines[1], 10) : 0;

    if (!isNaN(pid)) {
      // Layer 1: Same-PID — our own process already holds the lock (idempotent)
      if (pid === process.pid) {
        return;
      }

      // Layer 2: PID liveness — if process is dead, lock is stale
      if (isPidAlive(pid)) {
        // Layer 3: Timestamp age — guard against Windows PID reuse
        const lockAge = timestamp > 0 ? Date.now() - timestamp : 0;
        if (timestamp === 0 || lockAge < LOCK_MAX_AGE_MS) {
          // PID alive and lock is fresh — real conflict
          throw new Error(
            `Another Nugget instance (PID ${pid}) is already polling this bot token. Only one instance can poll at a time.`,
          );
        }
        logWarn(
          `Stale lock detected: PID ${pid} alive but lock is ${Math.round(lockAge / 3600000)}h old — treating as stale`,
        );
      }
    }

    // Stale lock — try to atomically replace it
    // Delete the stale lock, then try exclusive creation again
    try {
      unlinkSync(lockPath);
    } catch {
      // File may have been deleted by another process — that's fine
    }

    // Retry exclusive creation after stale cleanup
    try {
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: 'wx' });
      return; // Lock acquired
    } catch (retryErr: unknown) {
      if ((retryErr as NodeJS.ErrnoException).code === 'EEXIST') {
        // Another process beat us to it after stale cleanup — they won
        throw new Error(
          'Another Nugget instance acquired the bot lock during promotion race. Only one instance can poll at a time.',
        );
      }
      throw retryErr;
    }
  } catch (err) {
    // Re-throw lock conflict errors
    if (err instanceof Error && (err.message.includes('already polling') || err.message.includes('acquired the bot lock'))) {
      throw err;
    }
    // File disappeared between wx attempt and readFileSync — retry once
    try {
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: 'wx' });
      return;
    } catch {
      throw new Error('Failed to acquire bot lock after stale cleanup race');
    }
  }
}

/**
 * Try to acquire the bot lock. Returns true if this process now holds it,
 * false if another live process already holds it.
 */
export function tryAcquireBotLock(token: string): boolean {
  try {
    acquireBotLock(token);
    return true;
  } catch {
    return false;
  }
}

/** Release the bot lock file for a given token. Safe to call even if no lock exists. */
export function releaseBotLock(token: string): void {
  const lockPath = lockFilePath(token);
  try {
    unlinkSync(lockPath);
  } catch {
    // Ignore -- lock may not exist
  }
}

export async function createBot(token: string, ownerId: number): Promise<Bot> {
  // Return cached bot if same process already created one for this token
  const cached = botCache.get(token);
  if (cached) return cached;

  // Lock is already acquired by tryAcquireBotLock() in index.ts before createBot is called.
  // Do NOT call acquireBotLock here — it was the root cause of the double-acquire bug.

  const bot = new Bot(token);

  // Install rate limiter FIRST -- proactively throttles all API calls to prevent 429s.
  // editMessageText (99.4% of 429s) gets 350ms minimum spacing; all calls get 50ms base spacing.
  bot.api.config.use(createRateLimiter());

  // Install auto-retry AFTER rate limiter -- catches any 429s that slip through and
  // waits the full retry_after duration (even 500+ seconds). Previous config of
  // maxDelaySeconds=30 caused cascading failures when retry_after exceeded 30s.
  bot.api.config.use(autoRetry());

  // Register owner-only auth as first middleware -- all messages from non-owners are silently dropped
  bot.use(ownerOnly(ownerId));

  // Validate token by calling getMe -- if token is invalid, this throws
  try {
    const me = await bot.api.getMe();
    logInfo(`Bot connected: @${me.username}`);

    // Register bot commands menu -- overwrites stale commands from previous bot on same token
    await bot.api.setMyCommands([
      { command: 'start', description: 'Welcome message and quick start' },
      { command: 'hub', description: 'Show sessions hub with controls' },
      { command: 'controls', description: 'Show session control buttons' },
      { command: 'settings', description: 'Notification settings' },
      { command: 'help', description: 'Command reference' },
    ]);
  } catch (err: unknown) {
    // Release lock on validation failure so another process can try
    releaseBotLock(token);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid bot token -- verify BOT_TOKEN in .env: ${message}`);
  }

  // Global error handler -- catches any unhandled middleware errors so they don't
  // become uncaught promise rejections that crash Node.js.
  bot.catch((err) => {
    logError('Unhandled bot error:', err.error);
  });

  // Cache the bot for same-process reuse
  botCache.set(token, bot);

  return bot;
}

/** Derive a deterministic TCP port from the token hash for IPC.
 *  Maps into the dynamic/private port range 49152-65535. */
function ipcPort(token: string): number {
  const hash = tokenHash(token);
  // Parse first 4 hex chars (0-65535), then clamp to 49152-65535 range
  const raw = parseInt(hash.slice(0, 4), 16);
  return 49152 + (raw % (65535 - 49152 + 1));
}

let ipcServer: Server | null = null;

// ── Bidirectional IPC Protocol ──────────────────────────────────────────

/**
 * Bridge for a remote session living in another process.
 * Primary sends input to secondary; secondary sends output to primary.
 */
export interface RemoteSessionBridge {
  /** Send input from primary (Telegram) to the secondary process's PTY. */
  sendInput(data: string): void;
  /** Register a callback for PTY output from the secondary process. */
  onOutput(cb: (data: string) => void): void;
  /** Ask the secondary to trigger a screen redraw (no-op resize → SIGWINCH). */
  requestRedraw(): void;
  /** Tell this secondary it should promote to primary. */
  sendPromote(): void;
  /** Tell this secondary to shut down gracefully. */
  sendExit(): void;
}

/**
 * Callbacks for the enhanced IPC server.
 */
export interface IpcCallbacks {
  /** Fire-and-forget: spawn a session in the primary process (legacy). */
  onSpawn: (sessionName: string) => Promise<void>;
  /** A secondary process registered a remote session. */
  onRegister: (sessionName: string, bridge: RemoteSessionBridge) => void;
  /** A secondary process unregistered (session exited or disconnected). */
  onUnregister: (sessionName: string) => void;
}

/**
 * Start an IPC server on TCP localhost to handle spawn requests and
 * bidirectional session bridging from secondary Nugget instances.
 *
 * Protocol (newline-delimited messages):
 *   spawn:<name>                  -- fire-and-forget session spawn (legacy)
 *   register:<name>               -- register a remote session (keeps socket open)
 *   unregister:<name>             -- unregister remote session, close socket
 *   output:<base64>               -- PTY output from secondary -> primary
 *   input:<base64>                -- Telegram input from primary -> secondary
 */
export function startIpcServer(
  token: string,
  callbacks: IpcCallbacks,
): void {
  const port = ipcPort(token);

  ipcServer = createServer((socket) => {
    // Handle socket errors first -- MUST be registered before any async work
    // to prevent unhandled 'error' events from crashing the process.
    socket.on('error', (err: NodeJS.ErrnoException) => {
      // ECONNRESET is expected when IPC client disconnects after sending spawn request.
      // EPIPE happens if we try to write after client already closed.
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
        // If this was a registered session, clean it up
        if (registeredSession) {
          callbacks.onUnregister(registeredSession);
          registeredSession = null;
        }
        return;
      }
      logError('IPC socket error:', err.message);
    });

    const safeWrite = (msg: string) => {
      if (!socket.destroyed) {
        socket.write(msg);
      }
    };

    // Track whether this socket has a registered session (persistent connection)
    let registeredSession: string | null = null;
    let outputCallback: ((data: string) => void) | null = null;
    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      // Keep incomplete last line in buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const msg = line.trim();
        if (!msg) continue;

        if (msg.startsWith('spawn:')) {
          // Legacy fire-and-forget spawn
          const name = msg.slice(6);
          try {
            await callbacks.onSpawn(name);
            safeWrite('ok\n');
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            safeWrite(`error:${message}\n`);
          }
          if (!socket.destroyed) socket.end();
        } else if (msg.startsWith('register:')) {
          // Persistent connection: register remote session
          const name = msg.slice(9);
          registeredSession = name;

          const bridge: RemoteSessionBridge = {
            sendInput(inputData: string) {
              const encoded = Buffer.from(inputData).toString('base64');
              safeWrite(`input:${encoded}\n`);
            },
            onOutput(cb: (outputData: string) => void) {
              outputCallback = cb;
            },
            requestRedraw() {
              safeWrite('redraw\n');
            },
            sendPromote() {
              safeWrite('promote\n');
            },
            sendExit() {
              safeWrite('exit\n');
            },
          };

          callbacks.onRegister(name, bridge);
          safeWrite('ok\n');
        } else if (msg.startsWith('unregister:')) {
          const name = msg.slice(11);
          if (registeredSession === name) {
            callbacks.onUnregister(name);
            registeredSession = null;
          }
          safeWrite('ok\n');
          if (!socket.destroyed) socket.end();
        } else if (msg.startsWith('output:')) {
          // PTY output from secondary process
          const encoded = msg.slice(7);
          try {
            const decoded = Buffer.from(encoded, 'base64').toString();
            if (outputCallback) {
              outputCallback(decoded);
            }
          } catch {
            // Ignore malformed base64
          }
        } else {
          safeWrite('error:unknown command\n');
        }
      }
    });

    // Handle socket close -- unregister if session was registered
    socket.on('close', () => {
      if (registeredSession) {
        callbacks.onUnregister(registeredSession);
        registeredSession = null;
      }
    });
  });

  ipcServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logWarn(`IPC port ${port} already in use — another instance may be running`);
    } else {
      logError('IPC server error:', err.message);
    }
  });

  ipcServer.listen(port, '127.0.0.1', () => {
    logInfo(`IPC server listening on 127.0.0.1:${port}`);
  });
}

/**
 * Connect to the primary instance's IPC server as a secondary process.
 * Registers a remote session and returns a bidirectional bridge.
 */
export function connectToPrimary(
  token: string,
  sessionName: string,
): { sendOutput(data: string): void; onInput(cb: (data: string) => void): void; onRedraw(cb: () => void): void; onDisconnect(cb: () => void): void; onPromote(cb: () => void): void; onExit(cb: () => void): void; onConnect(cb: () => void): void; unregister(): void } {
  const port = ipcPort(token);
  let inputCallback: ((data: string) => void) | null = null;
  let redrawCallback: (() => void) | null = null;
  let disconnectCallback: (() => void) | null = null;
  let promoteCallback: (() => void) | null = null;
  let connectCallback: (() => void) | null = null;
  let exitCallback: (() => void) | null = null;
  let buffer = '';

  const client = connect({ port, host: '127.0.0.1' }, () => {
    client.write(`register:${sessionName}\n`);
  });

  client.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const msg = line.trim();
      if (!msg) continue;

      if (msg.startsWith('input:')) {
        const encoded = msg.slice(6);
        try {
          const decoded = Buffer.from(encoded, 'base64').toString();
          if (inputCallback) {
            inputCallback(decoded);
          }
        } catch {
          // Ignore malformed base64
        }
      } else if (msg === 'redraw') {
        redrawCallback?.();
      } else if (msg === 'promote') {
        promoteCallback?.();
      } else if (msg === 'exit') {
        exitCallback?.();
      } else if (msg === 'ok') {
        connectCallback?.();
        connectCallback = null; // Only fire once
      }
    }
  });

  client.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ECONNREFUSED') {
      logError('Could not connect to primary instance IPC -- is it running?');
      disconnectCallback?.();
    } else if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
      disconnectCallback?.();
    } else {
      logError('IPC client error:', err.message);
    }
  });

  client.on('close', () => {
    disconnectCallback?.();
  });

  return {
    sendOutput(data: string): void {
      if (!client.destroyed) {
        const encoded = Buffer.from(data).toString('base64');
        client.write(`output:${encoded}\n`);
      }
    },
    onInput(cb: (data: string) => void): void {
      inputCallback = cb;
    },
    onRedraw(cb: () => void): void {
      redrawCallback = cb;
    },
    onDisconnect(cb: () => void): void {
      disconnectCallback = cb;
    },
    onPromote(cb: () => void): void {
      promoteCallback = cb;
    },
    onExit(cb: () => void): void {
      exitCallback = cb;
    },
    onConnect(cb: () => void): void {
      connectCallback = cb;
    },
    unregister(): void {
      if (!client.destroyed) {
        client.write(`unregister:${sessionName}\n`);
        client.end();
      }
    },
  };
}

/** Clean up IPC server on shutdown. */
export function stopIpcServer(_token: string): void {
  if (ipcServer) {
    ipcServer.close();
    ipcServer = null;
  }
}
