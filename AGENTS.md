# Nugget

## Project Overview

A Node.js framework that spawns Claude Code inside Docker sandboxes via node-pty, mirrors terminal output to Telegram, accepts commands back via text and inline buttons, and manages concurrent named sessions with a central hub.

## Stack

- **Runtime**: Node.js 22, TypeScript (ESM)
- **Bot**: grammY (Telegram Bot API)
- **Database**: SQLite (better-sqlite3)
- **Terminal**: @xterm/headless (terminal emulation)
- **PTY**: node-pty
- **CLI**: Commander

## Commands

```bash
npm run dev        # tsx watch src/index.ts
npm run build      # tsc
npm test           # node --import tsx --test test/**/*.test.ts
npm run lint       # eslint src --ext .ts
npm start          # node --env-file=.env dist/index.js
```

## Architecture

```
src/
├── cli/           # CLI entry point (nugget start)
├── config/        # Environment config loader
├── db/            # SQLite schema, migrations, stores
├── events/        # EventBus for inter-module communication
├── logging/       # Structured logger
├── output/        # HTML formatting for Telegram
├── security/      # Command allowlist
├── session/       # PTY manager, router, types
├── telegram/      # Bot, input/output handlers, hub, messages
└── index.ts       # Entry point — wires all modules
test/              # Unit/integration tests
```

## Key Patterns

- Service-per-concern modules with explicit interfaces
- All async I/O uses async/await — no raw callbacks
- Environment config via `.env` — never hardcode tokens or paths
- Three-component output pipeline: Emulator → ScreenCapture → TelegramOutputSink

## Known Issues

### better-sqlite3 cross-platform native module
`better-sqlite3` compiles a native binary at install time. After pulling on any platform, run `npm install` to rebuild. Tests touching SQLite will fail on the non-native platform — this is expected.
