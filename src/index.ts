import { loadConfig } from './config/env.js';
import { openDatabase } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { EventBus } from './events/bus.js';
import { SessionStore } from './db/sessions.js';
import { SessionManager } from './session/manager.js';
import { SessionRouter } from './session/router.js';
import {
  createBot,
  releaseBotLock,
  tryAcquireBotLock,
  startIpcServer,
  stopIpcServer,
  connectToPrimary,
  type IpcCallbacks,
} from './telegram/bot.js';
import { TelegramOutputSink } from './telegram/output.js';
import { TelegramInputHandler } from './telegram/input.js';
import { HubRenderer } from './telegram/hub.js';
import { HubStore } from './db/hub-store.js';
import { SettingsStore } from './db/settings-store.js';
import { registerCallbackHandlers, buildCLIKeyboard, buildControlsKeyboard } from './telegram/keyboard.js';
import { registerCommands, EphemeralTracker } from './telegram/commands.js';
import { CommandAllowlist } from './security/allowlist.js';
import { MessageStore } from './db/messages.js';
import { MessageTracker } from './telegram/messages.js';
import { TerminalEmulator } from './terminal/emulator.js';
import { ScreenCapture } from './terminal/capture.js';
import { TERMINAL_COLS, TERMINAL_ROWS } from './terminal/constants.js';
import { logInfo, logWarn, logError } from './logging/logger.js';
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
  // 2. Open SQLite database
  const db = openDatabase(config.dbPath);

  // 3. Run migrations to ensure schema is up to date
  runMigrations(db);

  // 4. Create event bus
  const bus = new EventBus();

  // 5. Create session store
  const store = new SessionStore(db);

  // 5b. Auto-suffix if a running session with the same name already exists
  const resolvedName = resolveSessionName(sessionName, store);
  if (resolvedName !== sessionName) {
    logInfo(`Session '${sessionName}' already exists -- using '${resolvedName}'`);
  }
  sessionName = resolvedName;

  // 6. Create session manager (with maxSessions from config)
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
  const bot = await createBot(config.botToken, config.ownerId);

  // 9. Create output sink
  // Pass CLI keyboard so every output message shows navigation buttons (no Delete)
  const outputSink = new TelegramOutputSink(bot.api, config.ownerId, buildCLIKeyboard());

  // 9b. Create TerminalEmulator + ScreenCapture pipeline
  // PTY data -> ScreenCapture.onData -> emulator -> OutputEvent -> sink.handleEvent
  const ptyCols = process.stdout.columns ?? TERMINAL_COLS;
  const ptyRows = process.stdout.rows ?? TERMINAL_ROWS;
  const emulator = new TerminalEmulator(ptyCols, ptyRows);
  const screenCapture = new ScreenCapture(emulator, (event) => {
    outputSink.handleEvent(event);
  }, { bus, sessionNameFn: () => router.activeSession });

  // 10. Create MessageStore and MessageTracker for message lifecycle management
  const messageStore = new MessageStore(db);
  const messageTracker = new MessageTracker(bot.api, config.ownerId, messageStore);

  // 11. Create HubRenderer with session name getter that includes remote sessions
  const hubStore = new HubStore(db);
  const hubRenderer = new HubRenderer(
    bot.api,
    config.ownerId,
    sessionManager,
    () => router.activeSession,
    () => router.getAll(),
    hubStore,
  );

  // 11b. Create SettingsStore for user preferences (notifications, etc.)
  const settingsStore = new SettingsStore(db);

  // 12. Create SessionRouter with MessageTracker (onHubUpdate triggers hub re-render)
  const router = new SessionRouter(
    outputSink, bus, () => hubRenderer.render(), messageTracker,
    () => screenCapture.resetBaseline(),  // reset diff baseline on session switch
  );

  // 12a. Wire headerFn to show "CLI of <session>" above output messages
  outputSink.headerFn = () => {
    const name = router.activeSession;
    return name ? `CLI of ${name}` : null;
  };

  // 12b. Wire local redraw: resize PTY to trigger SIGWINCH → Claude Code redraws
  router.onLocalRedraw = (name: string) => {
    try {
      sessionManager.resizeSession(name, ptyCols, ptyRows);
    } catch {
      // Session may have exited
    }
  };

  // 12c. Wire PTY data from EventBus to ScreenCapture (filtered by active session)
  bus.on('session:output', (name: string, data: string) => {
    if (router.activeSession === name) {
      screenCapture.onData(data);
    }
  });

  // 12c. Wire completion detection: send Telegram notification when "Crunched for" is detected and output settles
  screenCapture.onPromptComplete = () => {
    if (settingsStore.get('notifications')) {
      const session = router.activeSession;
      const label = session ? `Session "${session}" prompt completed.` : 'Prompt completed.';
      bot.api.sendMessage(config.ownerId, label, {
        disable_notification: false,
        reply_markup: {
          inline_keyboard: [[{ text: '🗑 Delete', callback_data: 'action:delete' }]],
        },
      }).catch((err) => logError('Notification failed:', err));
    }
  };

  // 13. Wire onMessageCreated hook: track every output message for the active session
  outputSink.onMessageCreated = (messageId: number) => {
    const session = router.activeSession;
    if (session) messageTracker.track(session, messageId);
  };

  // 13b. Wire onMessageCompleted hook: capture content when messages fill to EFFECTIVE_LIMIT
  // This ensures persistAndDelete saves real text content, not empty strings
  outputSink.onMessageCompleted = (messageId: number, text: string) => {
    const session = router.activeSession;
    if (session) messageTracker.updateContent(session, messageId, text);
  };

  // 13c. Wire flow control: pause PTY when Telegram queue backs up (CAPT-05)
  outputSink.onHighWater = () => {
    const session = router.activeSession;
    if (session) sessionManager.pauseSession(session);
  };
  outputSink.onLowWater = () => {
    const session = router.activeSession;
    if (session) sessionManager.resumeSession(session);
  };

  // 14. Wire lifecycle events to hub
  // NOTE: session:started does NOT re-render the hub here.
  // The hub is already rendered by router.switchTo() -> onHubUpdate().
  // Adding hubRenderer.render() here caused duplicate hub messages.
  bus.on('session:exit', (name: string) => {
    router.remove(name);
    hubRenderer.render();
  });

  // 14b. Wire exec-state changes to hub for dynamic busy/idle display
  bus.on('session:exec-state', (name: string, state: 'busy' | 'idle') => {
    hubRenderer.setExecState(name, state);
    hubRenderer.render();
  });

  // 15. Create input pipeline with dynamic session getter
  const allowlist = new CommandAllowlist(config.commandAllowlist);
  const inputHandler = new TelegramInputHandler(
    sessionManager,
    () => router.activeSession,
    allowlist,
  );

  // 15b. Wrap writeToSession to support remote sessions + reset completion detection on input
  const originalWrite = sessionManager.writeToSession.bind(sessionManager);
  sessionManager.writeToSession = (name: string, data: string) => {
    screenCapture.markInputSent();
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
  registerCommands(bot, sessionManager, () => router.activeSession, hubRenderer, ephemeralTracker, settingsStore);
  bot.command('controls', async (ctx) => {
    const result = await ctx.reply('Session controls:', { reply_markup: buildControlsKeyboard() });
    await ephemeralTracker.track((result as { message_id: number }).message_id);
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
  });
  bot.on('message:text', inputHandler.handler());
  registerCallbackHandlers(bot, sessionManager, () => router.activeSession, router, () => hubRenderer.render(), screenCapture, async () => { hubRenderer.toggleAdvanced(); await hubRenderer.render(); }, async () => { shutdownFn?.('hub-disconnect'); }, async () => { await hubRenderer.delete(); });

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
    onRegister: (name, bridge) => {
      // Remote session from another CLI process
      router.addRemote(name, bridge);
      logInfo(`IPC: Remote session '${name}' registered`);
      hubRenderer.render();

      // Wire remote session output directly to ScreenCapture (bypassing bus)
      // Remote output should NOT go through the bus -- it would hit the stdout
      // listener and bleed remote text into the primary CLI. The primary only
      // needs remote output for Telegram display via ScreenCapture.
      bridge.onOutput((data: string) => {
        if (router.activeSession === name) {
          screenCapture.onData(data);
        }
      });
    },
    onUnregister: (name) => {
      router.removeRemote(name);
      logInfo(`IPC: Remote session '${name}' unregistered`);
      hubRenderer.render();
    },
  };
  startIpcServer(config.botToken, ipcCallbacks);

  // 18. Register with router and switch BEFORE starting PTY
  // ScreenCapture is already wired via EventBus (step 9c) so PTY data flows through the pipeline.
  router.add(sessionName);
  router.switchTo(sessionName);

  // 19. Start the first session (PTY output now captured by output sink)
  const session = await sessionManager.start(sessionName, { cols: ptyCols, rows: ptyRows });

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

    // 22. Handle SIGWINCH to resize PTY and emulator when terminal is resized
    const sigwinchHandler = () => {
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      if (cols && rows) {
        try {
          sessionManager.resizeSession(sessionName, cols, rows);
          emulator.resize(cols, rows);
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
  const shutdown = setupPrimaryShutdown(bot, config.botToken, sessionManager, router, db, outputSink, screenCapture, emulator, cleanupStdin);
  shutdownFn = shutdown;

  // 24. Auto-shutdown when the main session PTY exits (e.g. CTRL-C in sandbox)
  bus.on('session:exit', (name: string) => {
    if (name === sessionName) {
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

  // 5b. Auto-suffix if a running session with the same name already exists
  const resolvedName = resolveSessionName(sessionName, store);
  if (resolvedName !== sessionName) {
    logInfo(`Session '${sessionName}' already exists -- using '${resolvedName}'`);
  }
  sessionName = resolvedName;

  // 6. Create session manager
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
  const session = await sessionManager.start(sessionName, { cols: ptyCols, rows: ptyRows });

  // 19. Connect to primary instance's IPC for Telegram visibility
  const ipcBridge = connectToPrimary(config.botToken, sessionName);

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

  // Unregister on session exit
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
    const bot = await createBot(config.botToken, config.ownerId);
    const outputSink = new TelegramOutputSink(bot.api, config.ownerId, buildCLIKeyboard());

    const emulator = new TerminalEmulator(ptyCols, ptyRows);
    const capture = new ScreenCapture(emulator, (event) => {
      outputSink.handleEvent(event);
    }, { bus, sessionNameFn: () => router.activeSession });

    bus.off('session:output', stdoutHandler);
    bus.on('session:output', (name: string, data: string) => {
      if (name === sessionName) {
        process.stdout.write(data);
      }
    });

    bus.on('session:output', (name: string, data: string) => {
      if (router.activeSession === name) {
        capture.onData(data);
      }
    });

    const messageStore = new MessageStore(db);
    const messageTracker = new MessageTracker(bot.api, config.ownerId, messageStore);

    const hubStore = new HubStore(db);
    const hubRenderer = new HubRenderer(
      bot.api, config.ownerId, sessionManager,
      () => router.activeSession,
      () => router.getAll(),
      hubStore,
    );

    const settingsStore = new SettingsStore(db);

    const router = new SessionRouter(
      outputSink, bus, () => hubRenderer.render(), messageTracker,
      () => capture.resetBaseline(),
    );

    router.onLocalRedraw = (name: string) => {
      try { sessionManager.resizeSession(name, ptyCols, ptyRows); } catch {}
    };

    // Wire headerFn to show "CLI of <session>" above output messages
    outputSink.headerFn = () => {
      const name = router.activeSession;
      return name ? `CLI of ${name}` : null;
    };

    outputSink.onMessageCreated = (messageId: number) => {
      const session = router.activeSession;
      if (session) messageTracker.track(session, messageId);
    };
    outputSink.onMessageCompleted = (messageId: number, text: string) => {
      const session = router.activeSession;
      if (session) messageTracker.updateContent(session, messageId, text);
    };

    // Wire completion detection notification for promoted primary
    capture.onPromptComplete = () => {
      if (settingsStore.get('notifications')) {
        const session = router.activeSession;
        const label = session ? `Session "${session}" prompt completed.` : 'Prompt completed.';
        bot.api.sendMessage(config.ownerId, label, {
          disable_notification: false,
          reply_markup: {
            inline_keyboard: [[{ text: '🗑 Delete', callback_data: 'action:delete' }]],
          },
        }).catch((err) => logError('Notification failed:', err));
      }
    };

    const allowlist = new CommandAllowlist(config.commandAllowlist);
    const inputHandler = new TelegramInputHandler(
      sessionManager, () => router.activeSession, allowlist,
    );

    const originalWrite = sessionManager.writeToSession.bind(sessionManager);
    sessionManager.writeToSession = (name: string, data: string) => {
      capture.markInputSent();
      const bridge = router.getRemoteBridge(name);
      if (bridge) {
        bridge.sendInput(data);
      } else {
        originalWrite(name, data);
      }
    };

    let promotedShutdownFn: ((signal: string) => Promise<void>) | null = null;
    const ephemeralTracker = new EphemeralTracker(bot.api, config.ownerId);
    registerCommands(bot, sessionManager, () => router.activeSession, hubRenderer, ephemeralTracker, settingsStore);
    bot.command('controls', async (ctx) => {
      const result = await ctx.reply('Session controls:', { reply_markup: buildControlsKeyboard() });
      await ephemeralTracker.track((result as { message_id: number }).message_id);
      try { await ctx.deleteMessage(); } catch { /* ignore */ }
    });
    bot.on('message:text', inputHandler.handler());
    registerCallbackHandlers(bot, sessionManager, () => router.activeSession, router, () => hubRenderer.render(), capture, async () => { hubRenderer.toggleAdvanced(); await hubRenderer.render(); }, async () => { promotedShutdownFn?.('hub-disconnect'); }, async () => { await hubRenderer.delete(); });

    bus.on('session:exit', (name: string) => {
      router.remove(name);
      hubRenderer.render();
    });

    // Wire exec-state changes to hub for dynamic busy/idle display
    bus.on('session:exec-state', (name: string, state: 'busy' | 'idle') => {
      hubRenderer.setExecState(name, state);
      hubRenderer.render();
    });

    router.add(sessionName);
    router.switchTo(sessionName);

    const ipcCallbacks: IpcCallbacks = {
      onSpawn: async (name) => {
        router.add(name);
        router.switchTo(name);
        await sessionManager.start(name, { cols: ptyCols, rows: ptyRows });
      },
      onRegister: (name, bridge) => {
        router.addRemote(name, bridge);
        hubRenderer.render();
        bridge.onOutput((data: string) => {
          if (router.activeSession === name) {
            capture.onData(data);
          }
        });
      },
      onUnregister: (name) => {
        router.removeRemote(name);
        hubRenderer.render();
      },
    };
    startIpcServer(config.botToken, ipcCallbacks);

    bot.start({ onStart: () => logInfo('Promoted to primary -- Telegram bot listening') });

    // Set up graceful shutdown for the promoted primary
    promotedShutdownFn = setupPrimaryShutdown(bot, config.botToken, sessionManager, router, db, outputSink, capture, emulator);

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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    logInfo(`Reconnecting to new primary (attempt ${attempt}/${MAX_ATTEMPTS})...`);

    try {
      const newBridge = connectToPrimary(config.botToken, sessionName);

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
  outputSink: TelegramOutputSink,
  screenCapture: ScreenCapture,
  emulator: TerminalEmulator,
  cleanupStdin?: () => void,
): (signal: string) => Promise<void> {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`Received ${signal}, shutting down...`);

    // Restore stdin state before anything else
    cleanupStdin?.();

    try {
      // Flush pending ScreenCapture debounce (synchronous -- fires onOutput callback)
      screenCapture.flush();
      // Wait for all queued Telegram API calls to complete
      await outputSink.drain();
      // Dispose ScreenCapture and emulator to prevent memory leaks
      screenCapture.dispose();
      emulator.dispose();
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

    // Stop IPC server and clean up socket
    stopIpcServer(botToken);

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
