import { loadConfig } from './config/env.js';
import { openDatabase } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { EventBus } from './events/bus.js';
import { SessionStore } from './db/sessions.js';
import { SessionManager, setRuntimeMode } from './session/manager.js';
import { SessionRouter } from './session/router.js';
import {
  createBot,
  releaseBotLock,
  removePortFile,
  tryAcquireBotLock,
  startIpcServer,
  stopIpcServer,
  connectToPrimary,
  type IpcCallbacks,
} from './telegram/bot.js';
import { TelegramInputHandler } from './telegram/input.js';
import { HubRenderer } from './telegram/hub.js';
import { RateLimiter } from './telegram/rate-limiter.js';
import { HubStore } from './db/hub-store.js';
import { SettingsStore } from './db/settings-store.js';
import { AutomationStore } from './db/automation-store.js';
import { HistoryStore } from './db/history-store.js';
import { registerCallbackHandlers } from './telegram/keyboard.js';
import { registerCommands, EphemeralTracker } from './telegram/commands.js';
import { CommandAllowlist } from './security/allowlist.js';
import { TerminalEmulator } from './terminal/emulator.js';
import { ScreenCapture } from './terminal/capture.js';
import { CompletionTracker } from './terminal/completion-tracker.js';
import { makeCleanupSession } from './cleanup.js';
import { TERMINAL_COLS, TERMINAL_ROWS } from './terminal/constants.js';
import { AutomationHubRenderer } from './telegram/automation-hub.js';
import { AutomationEngine } from './automation/engine.js';
import type { EngineConfig } from './automation/engine.js';
import { logDebug, logInfo, logWarn, logError, cleanOldLogs, rotateLog } from './logging/logger.js';
import type { Bot } from 'grammy';
import type Database from 'better-sqlite3';

/**
 * Resolve a unique session name by appending -2, -3, etc. if the base name
 * is already taken in the session store.
 */
function resolveSessionName(name: string, store: SessionStore): string {
  const existing = store.findByName(name);
  if (!existing || existing.status === 'stopped' || existing.status === 'stopping') {
    return name;
  }
  // Name is taken by a running/starting session -- find next available suffix
  let suffix = 2;
  while (true) {
    const candidate = `${name}-${suffix}`;
    const check = store.findByName(candidate);
    if (!check || check.status === 'stopped' || check.status === 'stopping') {
      return candidate;
    }
    suffix++;
  }
}

export async function startFramework(
  sessionName: string,
): Promise<void> {
  // 1. Load typed config from environment
  const config = loadConfig();

  // 2. Determine if this is primary (bot owner) or secondary (headless) instance
  const isPrimary = tryAcquireBotLock(config.botToken);

  if (isPrimary) {
    await startPrimary(config, sessionName);
  } else {
    await startSecondary(config, sessionName);
  }
}

// ── Primary instance: full Telegram bot + IPC server ─────────────────────

async function startPrimary(
  config: ReturnType<typeof loadConfig>,
  sessionName: string,
): Promise<void> {
  logInfo(`[primary] Starting primary instance, session='${sessionName}', runtime='${config.runtime}'`);

  // 1b. Rotate previous log and clean up old log files
  rotateLog();
  cleanOldLogs(config.logTtlHours);

  // 2. Open SQLite database
  logDebug(`[primary] Opening database at ${config.dbPath}`);
  const db = openDatabase(config.dbPath);

  // 3. Run migrations to ensure schema is up to date
  runMigrations(db);

  // 4. Create event bus
  const bus = new EventBus();

  // 5. Create session store
  const store = new SessionStore(db);

  // 5a. Clean up stale session records from previous crashed processes (SESS-03)
  const cleaned = store.cleanupStale();
  if (cleaned > 0) {
    logInfo(`Cleaned up ${cleaned} stale session record(s) from previous run`);
  }

  // 5b. Auto-suffix if a running session with the same name already exists
  const originalName = sessionName;
  const resolvedName = resolveSessionName(sessionName, store);
  if (resolvedName !== sessionName) {
    logInfo(`Session '${sessionName}' already exists -- using '${resolvedName}'`);
  }
  sessionName = resolvedName;

  // 6. Create session manager (with maxSessions from config)
  setRuntimeMode(config.runtime);
  const sessionManager = new SessionManager(bus, store, undefined, config.maxSessions);

  // 7. Subscribe to event bus for console logging (filtered to local session only)
  bus.on('session:output', (name: string, data: string) => {
    if (name === sessionName) {
      process.stdout.write(data);
    }
  });
  bus.on('session:started', (name: string) => {
    logInfo('Session started:', name);
  });
  bus.on('session:exit', (name: string, code: number) => {
    logInfo('Session exited:', name, 'code:', code);
  });

  // 8. Create Telegram bot (validates token via getMe)
  const rateLimiter = new RateLimiter();
  const bot = await createBot(config.botToken, config.ownerId, rateLimiter);

  // 8b. Create SettingsStore early (needed by keyboard builders below)
  const settingsStore = new SettingsStore(db);

  // 9b. Create per-session TerminalEmulator map + ScreenCapture pipeline
  // PTY data -> ScreenCapture.onData -> emulator -> OutputEvent -> hub CLI view
  const ptyCols = process.stdout.columns ?? TERMINAL_COLS;
  const ptyRows = process.stdout.rows ?? TERMINAL_ROWS;
  const emulators = new Map<string, TerminalEmulator>();

  function getOrCreateEmulator(name: string): TerminalEmulator {
    let emu = emulators.get(name);
    if (!emu) {
      emu = new TerminalEmulator(ptyCols, ptyRows);
      emulators.set(name, emu);
    }
    return emu;
  }

  const initialEmulator = getOrCreateEmulator(sessionName);
  const screenCapture = new ScreenCapture(initialEmulator, (event) => {
    const session = router.activeSession;
    if (!session) return;
    if (event.mode === 'replace') {
      hubRenderer.setCliContent(session, event.text);
    } else {
      // Append mode: accumulate onto existing content
      const current = hubRenderer.getCliContent();
      hubRenderer.setCliContent(session, current.screenText + event.text);
    }
    if (hubRenderer.hubView === 'cli') {
      hubRenderer.render({ mandatory: false });
    }
  }, { bus, sessionNameFn: () => router.activeSession });

  // 11. Create HubRenderer with session name getter that includes remote sessions
  const hubStore = new HubStore(db);
  const hubRenderer = new HubRenderer(
    bot.api,
    config.ownerId,
    sessionManager,
    () => router.activeSession,
    () => router.getAll(),
    (name: string) => router.isRemote(name),
    hubStore,
    rateLimiter,
    (name: string) => router.getRemoteMetadata(name),
  );

  // 11c. Create AutomationHubRenderer with engine factory and persistence store
  const automationStore = new AutomationStore(db);
  const historyStore = new HistoryStore(db);
  const automationHub = new AutomationHubRenderer(
    bot.api,
    config.ownerId,
    () => router.getAll(),
    (engineConfig: EngineConfig, engineBus: EventBus) =>
      new AutomationEngine(
        {
          ...engineConfig,
          maxCycles: settingsStore.getNumber('cycle_limit', 100),
          ptyCols,
          ptyRows,
          requestOrchestratorRedraw: () => {
            const bridge = router.getRemoteBridge(engineConfig.orchestratorSession);
            if (bridge) {
              bridge.requestRedraw();
            } else {
              // Local session: resize to trigger SIGWINCH
              try { sessionManager.resizeSession(engineConfig.orchestratorSession, ptyCols, ptyRows); } catch { /* may have exited */ }
            }
          },
        },
        sessionManager,
        engineBus,
      ),
    bus,
    automationStore,
    historyStore,
  );

  // 11d. Wire automationHub into HubRenderer for integrated display
  hubRenderer.setAutomationHub(automationHub);
  automationHub.onRender = () => hubRenderer.render();

  // 12. Create SessionRouter (simplified: no TelegramOutputSink or MessageTracker)
  const router = new SessionRouter(bus, () => {
    hubRenderer.render();
  });

  // 12a. Wire session switch callback: swap emulator, clear CLI content, switch to CLI view
  router.onSessionSwitch = (_from, to) => {
    const targetEmulator = getOrCreateEmulator(to);
    const priorMarker = completionTracker.getLastFiredMarker(to);
    screenCapture.swapEmulator(targetEmulator);
    if (priorMarker) {
      screenCapture.setLastFiredMarker(priorMarker);
    }
    hubRenderer.setCliContent(to, '');
    hubRenderer.setHubView('cli');
  };

  // 12b. Wire local redraw: resize PTY to trigger SIGWINCH -> Claude Code redraws
  router.onLocalRedraw = (name: string) => {
    try {
      sessionManager.resizeSession(name, ptyCols, ptyRows);
    } catch {
      // Session may have exited
    }
  };

  // 12c. Wire PTY data from EventBus to ScreenCapture and per-session emulators
  bus.on('session:output', (name: string, data: string) => {
    if (router.activeSession === name) {
      // Active session: data flows through ScreenCapture which writes to its internal emulator
      screenCapture.onData(data);
    } else {
      // Non-active session: write directly to the session's emulator for scrollback accumulation
      const emu = emulators.get(name);
      if (emu) {
        emu.write(data);
      }
    }
  });

  // 12c-2. Wire CompletionTracker for non-active session completion notifications
  const completionTracker = new CompletionTracker();
  completionTracker.onComplete = (sessionName: string) => {
    if (!settingsStore.get('notifications')) return;
    // Skip active session -- ScreenCapture handles it with full spinner guard
    if (sessionName === router.activeSession) return;
    // Skip automated worker sessions
    if (automationHub.isAutomatedSession(sessionName)) return;
    const label = `Session "${sessionName}" prompt completed.`;
    bot.api.sendMessage(config.ownerId, label, {
      disable_notification: false,
      reply_markup: {
        inline_keyboard: [[{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }]],
      },
    }).catch((err) => logError('Notification failed:', err));
  };

  // Feed all non-active session output to CompletionTracker
  bus.on('session:output', (name: string, data: string) => {
    if (name !== router.activeSession) {
      completionTracker.onData(name, data);
    }
  });

  // 12c. Wire completion detection: send Telegram notification when "Crunched for" is detected and output settles
  screenCapture.onPromptComplete = () => {
    if (settingsStore.get('notifications')) {
      const session = router.activeSession;
      // Skip notification for automated worker sessions -- engine handles the cycle
      if (session && automationHub.isAutomatedSession(session)) return;
      const label = session ? `Session "${session}" prompt completed.` : 'Prompt completed.';
      bot.api.sendMessage(config.ownerId, label, {
        disable_notification: false,
        reply_markup: {
          inline_keyboard: [[{ text: '🗑 Delete', callback_data: 'action:delete' }]],
        },
      }).catch((err) => logError('Notification failed:', err));
    }
  };

  // 14. Wire lifecycle events to hub
  // NOTE: session:started does NOT re-render the hub here.
  // The hub is already rendered by router.switchTo() -> onHubUpdate().
  // Adding hubRenderer.render() here caused duplicate hub messages.
  const cleanupSession = makeCleanupSession(router, hubRenderer, completionTracker, emulators);
  bus.on('session:exit', (name: string) => {
    cleanupSession(name);
  });

  // 14b. Wire exec-state changes to hub for dynamic busy/idle display (debounced)
  bus.on('session:exec-state', (name: string, state: 'busy' | 'idle') => {
    hubRenderer.setExecState(name, state);
    hubRenderer.debouncedRender();
  });

  // 15. Create input pipeline with dynamic session getter
  const allowlist = new CommandAllowlist(config.commandAllowlist);
  const inputHandler = new TelegramInputHandler(
    sessionManager,
    () => router.activeSession,
    allowlist,
    automationHub,
  );

  // 15b. Wrap writeToSession to support remote sessions + reset completion detection on input
  const originalWrite = sessionManager.writeToSession.bind(sessionManager);
  sessionManager.writeToSession = (name: string, data: string) => {
    screenCapture.markInputSent();
    completionTracker.markInputSent(name);
    const bridge = router.getRemoteBridge(name);
    if (bridge) {
      bridge.sendInput(data);
    } else {
      originalWrite(name, data);
    }
  };

  // 16. Register Telegram commands and handlers (must be before bot.start)
  let shutdownFn: ((signal: string) => Promise<void>) | null = null;
  const ephemeralTracker = new EphemeralTracker(bot.api, config.ownerId);
  registerCommands(bot, sessionManager, () => router.activeSession, hubRenderer, ephemeralTracker, settingsStore, (name: string, data: string) => sessionManager.writeToSession(name, data));
  bot.on('message:text', inputHandler.handler());
  registerCallbackHandlers(bot, sessionManager, () => router.activeSession, router, () => hubRenderer.render(), screenCapture, async () => { hubRenderer.toggleAdvanced(); await hubRenderer.render(); }, async () => { shutdownFn?.('hub-disconnect'); }, async () => { await hubRenderer.delete(); }, async (view: 'sessions' | 'automationHub' | 'automationDetails' | 'cli') => { hubRenderer.setHubView(view); await hubRenderer.render(); }, automationHub, settingsStore, (locked: boolean) => { hubRenderer.setCliScrollState(locked, settingsStore.get('enter_confirmation')); });

  // 17. Start bot long polling in background (do NOT await -- it blocks forever)
  bot.start({ onStart: () => logInfo('Telegram bot listening') });

  // 17b. Start IPC server with bidirectional protocol for remote sessions
  const ipcCallbacks: IpcCallbacks = {
    onSpawn: async (name) => {
      // Keep existing spawn behavior as fallback (backward compat)
      router.add(name);
      router.switchTo(name);
      await sessionManager.start(name, { cols: ptyCols, rows: ptyRows });
      await hubRenderer.render();
      logInfo(`IPC: Session '${name}' spawned (in-process)`);
    },
    onRegister: (name, bridge, meta) => {
      // Remote session from another CLI process
      router.addRemote(name, bridge, meta);
      // Pre-create emulator so remote session data accumulates scrollback
      getOrCreateEmulator(name);
      logInfo(`IPC: Remote session '${name}' registered`);
      hubRenderer.render();

      // Emit remote session output on the bus so all listeners (ScreenCapture,
      // AutomationEngine, etc.) see it uniformly. The stdout listener (step 7)
      // filters by local sessionName, so remote output won't bleed to the CLI.
      bridge.onOutput((data: string) => {
        bus.emit('session:output', name, data);
      });
    },
    onUnregister: (name) => {
      router.removeRemote(name);
      // removeRemote already calls router.remove(name) internally, so we
      // inline the remaining cleanup ops (matching cleanupSession behavior)
      // rather than calling cleanupSession which would redundantly remove.
      hubRenderer.clearExecState(name);
      completionTracker.removeSession(name);
      const emu = emulators.get(name);
      if (emu) {
        emu.dispose();
        emulators.delete(name);
      }
      // Auto-switch if the unregistered remote session was active
      if (router.activeSession === null && router.getAll().length > 0) {
        router.switchTo(router.getAll()[0]);
      }
      hubRenderer.render();
      logInfo(`IPC: Remote session '${name}' unregistered`);
    },
  };
  startIpcServer(config.botToken, ipcCallbacks);

  // 18. Register with router and switch BEFORE starting PTY
  // ScreenCapture is already wired via EventBus (step 9c) so PTY data flows through the pipeline.
  router.add(sessionName);
  router.switchTo(sessionName);

  // 19. Start the first session (PTY output now captured by output sink)
  // Pass original name as containerName when suffix was applied (SESS-02)
  const session = await sessionManager.start(sessionName, {
    cols: ptyCols,
    rows: ptyRows,
    ...(resolvedName !== originalName ? { containerName: originalName } : {}),
  });

  // 20. Log session status
  logInfo(`Session '${sessionName}' running (PID: ${session.pid})`);

  // 21. Pipe local stdin to PTY session (raw mode for keystroke forwarding)
  let cleanupStdin: (() => void) | undefined;

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const stdinHandler = (data: Buffer) => {
      try {
        sessionManager.writeToSession(sessionName, data.toString());
      } catch {
        // Session may have exited -- ignore
      }
    };
    process.stdin.on('data', stdinHandler);

    // 22. Handle SIGWINCH to resize PTY and all emulators when terminal is resized
    const sigwinchHandler = () => {
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      if (cols && rows) {
        try {
          sessionManager.resizeSession(sessionName, cols, rows);
          for (const emu of emulators.values()) {
            emu.resize(cols, rows);
          }
        } catch {
          // Session may have exited -- ignore
        }
      }
    };
    process.on('SIGWINCH', sigwinchHandler);

    cleanupStdin = () => {
      process.stdin.removeListener('data', stdinHandler);
      process.removeListener('SIGWINCH', sigwinchHandler);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };
  }

  // 23. Graceful shutdown on SIGINT/SIGTERM
  const shutdown = setupPrimaryShutdown(bot, config.botToken, sessionManager, router, db, screenCapture, emulators, cleanupStdin, automationHub);
  shutdownFn = shutdown;

  // 24. Auto-shutdown when the main session PTY exits AND no other sessions remain.
  // If other sessions still exist, the primary stays alive to serve them via Telegram.
  bus.on('session:exit', (name: string) => {
    if (name === sessionName && router.getAll().length === 0) {
      setTimeout(() => shutdown('session-exit'), 100);
    }
  });
}

// ── Secondary instance: headless, IPC bridge to primary ─────────────────

async function startSecondary(
  config: ReturnType<typeof loadConfig>,
  sessionName: string,
): Promise<void> {
  // 2. Open SQLite database (each process has its own DB for session tracking)
  const db = openDatabase(config.dbPath);

  // 3. Run migrations to ensure schema is up to date
  runMigrations(db);

  // 4. Create event bus
  const bus = new EventBus();

  // 5. Create session store
  const store = new SessionStore(db);

  // 5a. Clean up stale session records from previous crashed processes (SESS-03)
  const cleanedSecondary = store.cleanupStale();
  if (cleanedSecondary > 0) {
    logInfo(`Cleaned up ${cleanedSecondary} stale session record(s) from previous run`);
  }

  // 5b. Auto-suffix if a running session with the same name already exists
  const originalSecondaryName = sessionName;
  const resolvedName = resolveSessionName(sessionName, store);
  if (resolvedName !== sessionName) {
    logInfo(`Session '${sessionName}' already exists -- using '${resolvedName}'`);
  }
  sessionName = resolvedName;

  // 6. Create session manager
  setRuntimeMode(config.runtime);
  const sessionManager = new SessionManager(bus, store, undefined, config.maxSessions);

  // 7. Subscribe to event bus for console logging (named handler for promotion cleanup)
  const stdoutHandler = (name: string, data: string) => {
    if (name === sessionName) {
      process.stdout.write(data);
    }
  };
  bus.on('session:output', stdoutHandler);
  bus.on('session:started', (name: string) => {
    logInfo('Session started:', name);
  });
  bus.on('session:exit', (name: string, code: number) => {
    logInfo('Session exited:', name, 'code:', code);
  });

  const ptyCols = process.stdout.columns ?? TERMINAL_COLS;
  const ptyRows = process.stdout.rows ?? TERMINAL_ROWS;

  // 18. Start the session locally
  // Pass original name as containerName when suffix was applied (SESS-02)
  const session = await sessionManager.start(sessionName, {
    cols: ptyCols,
    rows: ptyRows,
    ...(resolvedName !== originalSecondaryName ? { containerName: originalSecondaryName } : {}),
  });

  // 19. Connect to primary instance's IPC for Telegram visibility
  const ipcBridge = connectToPrimary(config.botToken, sessionName, {
    pid: session.pid,
    createdAt: session.createdAt,
  });

  // Forward PTY output to primary so Telegram can see it
  bus.on('session:output', (name: string, data: string) => {
    if (name === sessionName) {
      ipcBridge.sendOutput(data);
    }
  });

  // Listen for explicit promotion signal from primary
  let wasPromoted = false;
  ipcBridge.onPromote(() => {
    wasPromoted = true;
    logInfo('Received promotion signal from primary');
  });

  // Detect primary process death -- promote or reconnect
  let disconnectHandled = false;
  ipcBridge.onDisconnect(async () => {
    if (disconnectHandled) return;
    disconnectHandled = true;

    if (wasPromoted) {
      // Graceful promotion: we were explicitly chosen by the dying primary
      logInfo('Primary shut down gracefully -- promoting to primary...');

      const lockAcquired = tryAcquireBotLock(config.botToken);
      if (!lockAcquired) {
        logError('Promoted but failed to acquire lock -- another instance took it');
        await attemptReconnect(config, sessionName, bus, sessionManager, ptyCols, ptyRows, db, stdoutHandler);
        return;
      }

      // Wait for Telegram to release the old getUpdates polling slot
      await new Promise(resolve => setTimeout(resolve, 2000));
      await becomeNewPrimary(config, sessionName, bus, sessionManager, db, ptyCols, ptyRows, stdoutHandler);
    } else {
      // Crash recovery or not chosen: wait for promoted secondary, then try lock or reconnect
      logWarn('Primary instance disconnected unexpectedly');

      // Wait for a potential promoted secondary to start up first
      await new Promise(resolve => setTimeout(resolve, 3000));

      const lockAcquired = tryAcquireBotLock(config.botToken);
      if (lockAcquired) {
        logInfo('No promoted secondary found -- promoting self (crash recovery)...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        await becomeNewPrimary(config, sessionName, bus, sessionManager, db, ptyCols, ptyRows, stdoutHandler);
      } else {
        logInfo('Another secondary was promoted -- reconnecting...');
        await attemptReconnect(config, sessionName, bus, sessionManager, ptyCols, ptyRows, db, stdoutHandler);
      }
    }
  });

  // Receive input from primary (Telegram) and write to local PTY
  ipcBridge.onInput((data: string) => {
    try {
      sessionManager.writeToSession(sessionName, data);
    } catch {
      // Session may have exited -- ignore
    }
  });

  // Redraw request from primary: resize PTY to same dimensions to trigger SIGWINCH,
  // which forces Claude Code (ink) to re-render and produce output
  ipcBridge.onRedraw(() => {
    try {
      sessionManager.resizeSession(sessionName, ptyCols, ptyRows);
    } catch {
      // Session may have exited -- ignore
    }
  });

  // Unregister from primary on session exit.
  // The IPC bridge's internal unregistering flag prevents this from
  // triggering the onDisconnect handler (which would falsely interpret
  // this self-initiated disconnect as the primary dying).
  bus.on('session:exit', (name: string) => {
    if (name === sessionName) {
      ipcBridge.unregister();
    }
  });

  logInfo(`Session '${sessionName}' running (PID: ${session.pid}) (headless -- Telegram controlled by primary instance)`);

  // 21. Pipe local stdin to PTY session (raw mode for keystroke forwarding)
  let cleanupStdin: (() => void) | undefined;

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const stdinHandler = (data: Buffer) => {
      try {
        sessionManager.writeToSession(sessionName, data.toString());
      } catch {
        // Session may have exited -- ignore
      }
    };
    process.stdin.on('data', stdinHandler);

    const sigwinchHandler = () => {
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      if (cols && rows) {
        try {
          sessionManager.resizeSession(sessionName, cols, rows);
        } catch {
          // Session may have exited -- ignore
        }
      }
    };
    process.on('SIGWINCH', sigwinchHandler);

    cleanupStdin = () => {
      process.stdin.removeListener('data', stdinHandler);
      process.removeListener('SIGWINCH', sigwinchHandler);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };
  }

  // 23. Graceful shutdown on SIGINT/SIGTERM
  const shutdown = setupSecondaryShutdown(sessionManager, db, ipcBridge, sessionName, cleanupStdin);

  // 23b. Wire remote exit command from primary (hub X button on hidden remote session)
  ipcBridge.onExit(() => {
    logInfo('Received exit signal from primary');
    shutdown('remote-exit');
  });

  // 24. Auto-shutdown when session PTY exits
  bus.on('session:exit', (name: string) => {
    if (name === sessionName) {
      setTimeout(() => shutdown('session-exit'), 100);
    }
  });
}

// ── Promotion helpers ────────────────────────────────────────────────────

async function becomeNewPrimary(
  config: ReturnType<typeof loadConfig>,
  sessionName: string,
  bus: EventBus,
  sessionManager: SessionManager,
  db: Database.Database,
  ptyCols: number,
  ptyRows: number,
  stdoutHandler: (name: string, data: string) => void,
): Promise<void> {
  try {
    // Clear ALL listeners from secondary phase to prevent duplicates.
    // becomeNewPrimary re-registers everything the primary needs below.
    bus.removeAllListeners();

    // Clean up stale session records from the crashed primary (SESS-03)
    const promotedStore = new SessionStore(db);
    const cleanedPromoted = promotedStore.cleanupStale();
    if (cleanedPromoted > 0) {
      logInfo(`Cleaned up ${cleanedPromoted} stale session record(s) from crashed primary`);
    }

    const rateLimiter = new RateLimiter();
    const bot = await createBot(config.botToken, config.ownerId, rateLimiter);
    const settingsStore = new SettingsStore(db);

    const emulators = new Map<string, TerminalEmulator>();

    function getOrCreateEmulator(name: string): TerminalEmulator {
      let emu = emulators.get(name);
      if (!emu) {
        emu = new TerminalEmulator(ptyCols, ptyRows);
        emulators.set(name, emu);
      }
      return emu;
    }

    const initialEmulator = getOrCreateEmulator(sessionName);
    const capture = new ScreenCapture(initialEmulator, (event) => {
      const session = router.activeSession;
      if (!session) return;
      if (event.mode === 'replace') {
        hubRenderer.setCliContent(session, event.text);
      } else {
        const current = hubRenderer.getCliContent();
        hubRenderer.setCliContent(session, current.screenText + event.text);
      }
      if (hubRenderer.hubView === 'cli') {
        hubRenderer.render({ mandatory: false });
      }
    }, { bus, sessionNameFn: () => router.activeSession });

    // Re-register session:started logger (cleared by removeAllListeners above)
    bus.on('session:started', (name: string) => {
      logInfo('Session started:', name);
    });

    bus.on('session:output', (name: string, data: string) => {
      if (name === sessionName) {
        process.stdout.write(data);
      }
    });

    bus.on('session:output', (name: string, data: string) => {
      if (router.activeSession === name) {
        // Active session: data flows through ScreenCapture which writes to its internal emulator
        capture.onData(data);
      } else {
        // Non-active session: write directly to the session's emulator for scrollback accumulation
        const emu = emulators.get(name);
        if (emu) {
          emu.write(data);
        }
      }
    });

    const hubStore = new HubStore(db);
    const hubRenderer = new HubRenderer(
      bot.api, config.ownerId, sessionManager,
      () => router.activeSession,
      () => router.getAll(),
      (name: string) => router.isRemote(name),
      hubStore,
      rateLimiter,
      (name: string) => router.getRemoteMetadata(name),
    );

    // Create AutomationHubRenderer for promoted primary with persistence store
    const promotedAutomationStore = new AutomationStore(db);
    const promotedHistoryStore = new HistoryStore(db);
    const promotedAutomationHub = new AutomationHubRenderer(
      bot.api,
      config.ownerId,
      () => router.getAll(),
      (engineConfig: EngineConfig, engineBus: EventBus) =>
        new AutomationEngine(
          {
            ...engineConfig,
            maxCycles: settingsStore.getNumber('cycle_limit', 100),
            ptyCols,
            ptyRows,
            requestOrchestratorRedraw: () => {
              const bridge = router.getRemoteBridge(engineConfig.orchestratorSession);
              if (bridge) {
                bridge.requestRedraw();
              } else {
                try { sessionManager.resizeSession(engineConfig.orchestratorSession, ptyCols, ptyRows); } catch { /* may have exited */ }
              }
            },
          },
          sessionManager,
          engineBus,
        ),
      bus,
      promotedAutomationStore,
      promotedHistoryStore,
    );

    // Wire automationHub into HubRenderer for integrated display
    hubRenderer.setAutomationHub(promotedAutomationHub);
    promotedAutomationHub.onRender = () => hubRenderer.render();

    const router = new SessionRouter(bus, () => {
      hubRenderer.render();
    });

    router.onSessionSwitch = (_from, to) => {
      const targetEmulator = getOrCreateEmulator(to);
      const priorMarker = promotedCompletionTracker.getLastFiredMarker(to);
      capture.swapEmulator(targetEmulator);
      if (priorMarker) {
        capture.setLastFiredMarker(priorMarker);
      }
      hubRenderer.setCliContent(to, '');
      hubRenderer.setHubView('cli');
    };

    router.onLocalRedraw = (name: string) => {
      try { sessionManager.resizeSession(name, ptyCols, ptyRows); } catch {}
    };

    // Wire completion detection notification for promoted primary
    capture.onPromptComplete = () => {
      if (settingsStore.get('notifications')) {
        const session = router.activeSession;
        // Skip notification for automated worker sessions -- engine handles the cycle
        if (session && promotedAutomationHub.isAutomatedSession(session)) return;
        const label = session ? `Session "${session}" prompt completed.` : 'Prompt completed.';
        bot.api.sendMessage(config.ownerId, label, {
          disable_notification: false,
          reply_markup: {
            inline_keyboard: [[{ text: '🗑 Delete', callback_data: 'action:delete' }]],
          },
        }).catch((err) => logError('Notification failed:', err));
      }
    };

    // Wire CompletionTracker for non-active session completion notifications (promoted primary)
    const promotedCompletionTracker = new CompletionTracker();
    promotedCompletionTracker.onComplete = (sessionName: string) => {
      if (!settingsStore.get('notifications')) return;
      if (sessionName === router.activeSession) return;
      if (promotedAutomationHub.isAutomatedSession(sessionName)) return;
      const label = `Session "${sessionName}" prompt completed.`;
      bot.api.sendMessage(config.ownerId, label, {
        disable_notification: false,
        reply_markup: {
          inline_keyboard: [[{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }]],
        },
      }).catch((err) => logError('Notification failed:', err));
    };

    bus.on('session:output', (name: string, data: string) => {
      if (name !== router.activeSession) {
        promotedCompletionTracker.onData(name, data);
      }
    });

    const allowlist = new CommandAllowlist(config.commandAllowlist);
    const inputHandler = new TelegramInputHandler(
      sessionManager, () => router.activeSession, allowlist, promotedAutomationHub,
    );

    const originalWrite = sessionManager.writeToSession.bind(sessionManager);
    sessionManager.writeToSession = (name: string, data: string) => {
      capture.markInputSent();
      promotedCompletionTracker.markInputSent(name);
      const bridge = router.getRemoteBridge(name);
      if (bridge) {
        bridge.sendInput(data);
      } else {
        originalWrite(name, data);
      }
    };

    let promotedShutdownFn: ((signal: string) => Promise<void>) | null = null;
    const ephemeralTracker = new EphemeralTracker(bot.api, config.ownerId);
    registerCommands(bot, sessionManager, () => router.activeSession, hubRenderer, ephemeralTracker, settingsStore, (name: string, data: string) => sessionManager.writeToSession(name, data));
    bot.on('message:text', inputHandler.handler());
    registerCallbackHandlers(bot, sessionManager, () => router.activeSession, router, () => hubRenderer.render(), capture, async () => { hubRenderer.toggleAdvanced(); await hubRenderer.render(); }, async () => { promotedShutdownFn?.('hub-disconnect'); }, async () => { await hubRenderer.delete(); }, async (view: 'sessions' | 'automationHub' | 'automationDetails' | 'cli') => { hubRenderer.setHubView(view); await hubRenderer.render(); }, promotedAutomationHub, settingsStore, (locked: boolean) => { hubRenderer.setCliScrollState(locked, settingsStore.get('enter_confirmation')); });

    const promotedCleanupSession = makeCleanupSession(router, hubRenderer, promotedCompletionTracker, emulators);
    bus.on('session:exit', (name: string) => {
      promotedCleanupSession(name);
    });

    // Wire exec-state changes to hub for dynamic busy/idle display (debounced)
    bus.on('session:exec-state', (name: string, state: 'busy' | 'idle') => {
      hubRenderer.setExecState(name, state);
      hubRenderer.debouncedRender();
    });

    router.add(sessionName);
    router.switchTo(sessionName);

    const ipcCallbacks: IpcCallbacks = {
      onSpawn: async (name) => {
        router.add(name);
        router.switchTo(name);
        await sessionManager.start(name, { cols: ptyCols, rows: ptyRows });
      },
      onRegister: (name, bridge, meta) => {
        router.addRemote(name, bridge, meta);
        // Pre-create emulator so remote session data accumulates scrollback
        getOrCreateEmulator(name);
        hubRenderer.render();
        bridge.onOutput((data: string) => {
          bus.emit('session:output', name, data);
        });
      },
      onUnregister: (name) => {
        router.removeRemote(name);
        // removeRemote already calls router.remove(name) internally, so we
        // inline the remaining cleanup ops (matching cleanupSession behavior).
        hubRenderer.clearExecState(name);
        promotedCompletionTracker.removeSession(name);
        const emu = emulators.get(name);
        if (emu) {
          emu.dispose();
          emulators.delete(name);
        }
        if (router.activeSession === null && router.getAll().length > 0) {
          router.switchTo(router.getAll()[0]);
        }
        hubRenderer.render();
      },
    };
    startIpcServer(config.botToken, ipcCallbacks);

    bot.start({ onStart: () => logInfo('Promoted to primary -- Telegram bot listening') });

    // Restore active automations from SQLite (persisted by crashed/stopped primary)
    const restoredCount = await promotedAutomationHub.restoreFromStore();
    if (restoredCount > 0) {
      logInfo(`Restored ${restoredCount} automation(s) from previous primary`);
    }

    // Handle SIGWINCH to resize PTY and all emulators when terminal is resized
    const sigwinchHandler = () => {
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      if (cols && rows) {
        try {
          sessionManager.resizeSession(sessionName, cols, rows);
          for (const emu of emulators.values()) {
            emu.resize(cols, rows);
          }
        } catch {
          // Session may have exited -- ignore
        }
      }
    };
    process.on('SIGWINCH', sigwinchHandler);

    const cleanupSigwinch = () => {
      process.removeListener('SIGWINCH', sigwinchHandler);
    };

    // Set up graceful shutdown for the promoted primary
    promotedShutdownFn = setupPrimaryShutdown(bot, config.botToken, sessionManager, router, db, capture, emulators, cleanupSigwinch, promotedAutomationHub);

    logInfo('Promotion complete -- Telegram control restored.');
  } catch (err) {
    logError('Promotion failed:', err);
    releaseBotLock(config.botToken);
    logWarn('Continuing as headless session.');
  }
}

async function attemptReconnect(
  config: ReturnType<typeof loadConfig>,
  sessionName: string,
  bus: EventBus,
  sessionManager: SessionManager,
  ptyCols: number,
  ptyRows: number,
  db: Database.Database,
  stdoutHandler: (name: string, data: string) => void,
): Promise<void> {
  const MAX_ATTEMPTS = 10;
  const BASE_DELAY = 3000;

  // Look up session metadata to send to the new primary
  const reconnectStore = new SessionStore(db);
  const reconnectSession = reconnectStore.findByName(sessionName);
  const reconnectMeta = reconnectSession
    ? { pid: reconnectSession.pid, createdAt: reconnectSession.createdAt }
    : undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    logInfo(`Reconnecting to new primary (attempt ${attempt}/${MAX_ATTEMPTS})...`);

    try {
      const newBridge = connectToPrimary(config.botToken, sessionName, reconnectMeta);

      const connected = await new Promise<boolean>((resolve) => {
        let settled = false;
        newBridge.onConnect(() => {
          if (!settled) { settled = true; resolve(true); }
        });
        newBridge.onDisconnect(() => {
          if (!settled) { settled = true; resolve(false); }
        });
        setTimeout(() => {
          if (!settled) { settled = true; resolve(false); }
        }, 5000);
      });

      if (!connected) {
        logWarn(`Reconnect attempt ${attempt} failed`);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, BASE_DELAY));
        }
        continue;
      }

      // Clear old output/exit listeners from previous connection to prevent accumulation.
      // session:started is harmless (just a logger) so we leave it.
      bus.removeAllListeners('session:output');
      bus.removeAllListeners('session:exit');

      // Re-register stdout handler for local console output
      bus.on('session:output', stdoutHandler);

      // Re-wire output forwarding to new primary
      bus.on('session:output', (name: string, data: string) => {
        if (name === sessionName) {
          newBridge.sendOutput(data);
        }
      });

      newBridge.onInput((data: string) => {
        try { sessionManager.writeToSession(sessionName, data); } catch {}
      });

      newBridge.onRedraw(() => {
        try { sessionManager.resizeSession(sessionName, ptyCols, ptyRows); } catch {}
      });

      // Wire exit command from new primary
      newBridge.onExit(() => {
        logInfo('Received exit signal from new primary');
        process.exit(0);
      });

      // Handle future disconnects from the new primary
      let wasPromoted = false;
      newBridge.onPromote(() => {
        wasPromoted = true;
        logInfo('Received promotion signal from new primary');
      });

      let disconnectHandled = false;
      newBridge.onDisconnect(async () => {
        if (disconnectHandled) return;
        disconnectHandled = true;

        if (wasPromoted) {
          logInfo('New primary shut down -- promoting to primary...');
          const lockAcquired = tryAcquireBotLock(config.botToken);
          if (lockAcquired) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            await becomeNewPrimary(config, sessionName, bus, sessionManager, db, ptyCols, ptyRows, stdoutHandler);
          } else {
            await attemptReconnect(config, sessionName, bus, sessionManager, ptyCols, ptyRows, db, stdoutHandler);
          }
        } else {
          logWarn('New primary disconnected unexpectedly');
          await new Promise(resolve => setTimeout(resolve, 3000));
          const lockAcquired = tryAcquireBotLock(config.botToken);
          if (lockAcquired) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            await becomeNewPrimary(config, sessionName, bus, sessionManager, db, ptyCols, ptyRows, stdoutHandler);
          } else {
            await attemptReconnect(config, sessionName, bus, sessionManager, ptyCols, ptyRows, db, stdoutHandler);
          }
        }
      });

      bus.on('session:exit', (name: string) => {
        if (name === sessionName) {
          newBridge.unregister();
        }
      });

      logInfo('Reconnected to new primary -- session visible in Telegram again');
      return;
    } catch (err) {
      logWarn(`Reconnect attempt ${attempt} error: ${err instanceof Error ? err.message : err}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, BASE_DELAY));
      }
    }
  }

  logWarn('Could not reconnect after all attempts. Session continues locally (headless).');
}

// ── Shutdown helpers ────────────────────────────────────────────────────

function setupPrimaryShutdown(
  bot: Bot,
  botToken: string,
  sessionManager: SessionManager,
  router: SessionRouter,
  db: Database.Database,
  screenCapture: ScreenCapture,
  emulators: Map<string, TerminalEmulator>,
  cleanupStdin?: () => void,
  automationHub?: { dispose(): void },
): (signal: string) => Promise<void> {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`Received ${signal}, shutting down...`);

    // Restore stdin state before anything else
    cleanupStdin?.();

    // Dispose automation hub before stopping sessions
    try {
      automationHub?.dispose();
    } catch {
      // Ignore -- best effort
    }

    try {
      // Flush pending ScreenCapture debounce (synchronous -- fires onOutput callback)
      screenCapture.flush();
      // Dispose ScreenCapture and all per-session emulators to prevent memory leaks
      screenCapture.dispose();
      for (const emu of emulators.values()) {
        emu.dispose();
      }
      emulators.clear();
    } catch {
      // Ignore -- best effort
    }

    // Stop ALL active sessions tracked by the router
    for (const name of router.getAll()) {
      try {
        await sessionManager.stop(name).catch(() => {
          // Session may have already exited
        });
      } catch {
        // Ignore -- best effort
      }
    }

    // Promote first remote secondary to take over Telegram bot
    const remoteNames = router.getAll().filter(n => router.isRemote(n));
    if (remoteNames.length > 0) {
      const successor = remoteNames[0];
      const bridge = router.getRemoteBridge(successor);
      if (bridge) {
        logInfo(`Promoting '${successor}' to primary before shutdown`);
        bridge.sendPromote();
        // Brief delay to ensure the promote message is delivered before socket closes
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    try {
      // Stop the Telegram bot
      await bot.stop();
      // Allow Telegram to fully release the old getUpdates long-poll
      // before another instance can start polling. Without this delay,
      // a promoted secondary may get a 409 "terminated by other getUpdates request".
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch {
      // Ignore -- best effort
    }

    // Stop IPC server and clean up socket + port file
    stopIpcServer(botToken);
    removePortFile(botToken);

    // Release bot polling lock so another Nugget instance can start
    releaseBotLock(botToken);

    try {
      // Close the database
      db.close();
    } catch {
      // Ignore -- best effort
    }

    logInfo('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return shutdown;
}

function setupSecondaryShutdown(
  sessionManager: SessionManager,
  db: Database.Database,
  ipcBridge: { unregister(): void },
  sessionName: string,
  cleanupStdin?: () => void,
): (signal: string) => Promise<void> {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`Received ${signal}, shutting down...`);

    cleanupStdin?.();

    // Unregister from primary
    try {
      ipcBridge.unregister();
    } catch {
      // Ignore -- primary may be gone
    }

    // Stop the local session
    try {
      await sessionManager.stop(sessionName).catch(() => {});
    } catch {
      // Ignore -- session may have already exited
    }

    try {
      db.close();
    } catch {
      // Ignore -- best effort
    }

    logInfo('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return shutdown;
}
