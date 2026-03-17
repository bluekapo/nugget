<div align="center">

<img src="docs/assets/nugget.jpg" alt="Nugget" width="128" />

# Nugget

**Run AI tasks while you sleep, walk, run, jump, or do anything other than sitting in front of your computer.**

</div>

---

## What is Nugget?

Nugget is a Node.js framework that spawns Claude Code inside Docker sandboxes, mirrors terminal output to Telegram, accepts commands back via text and inline buttons, and manages concurrent named sessions with a central hub. Use it to monitor and control long-running Claude Code sessions from your phone.

## Features

### Remote Terminal Mirroring

Real-time terminal output streamed to Telegram. Interact with sessions using inline buttons (approve, reject, scroll, navigate). Scroll lock lets you browse output while streaming continues. Multiple instances use a primary/secondary architecture with automatic promotion if the primary exits.

### Automation Orchestration

One Claude session (orchestrator) directs another (worker) via structured directives. Create an automation from the hub: select a worker session, select an orchestrator session, and enter a task description. The orchestrator issues directives -- COMMAND, SELECT, ENTER, WAIT, ESCALATE, YES, NO, CLEAR, RESET -- to drive the worker through multi-step tasks autonomously.

Safety controls keep automation bounded: a configurable cycle limit (10--1000, default 100) caps how many directive cycles run before stopping, and ESCALATE lets the orchestrator hand a decision back to you. Monitor progress, pause, resume, or stop automations from the hub. Context persists across cycles so the orchestrator maintains awareness of prior work.

### Notifications

Togglable prompt-completion alerts (via `/settings`) notify you when a session finishes processing and is waiting for input, so you know exactly when to check back in.

### Other Features

- Multi-session support with a central hub
- Session switching and concurrent named sessions
- Command allowlist for security
- Configurable settings (notifications, enter confirmation, cycle limit)

## Prerequisites

- Node.js (LTS recommended)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))
- Docker (if running Claude Code in sandboxes)

## Quick Start

### Installation

```bash
git clone https://github.com/AshGw/nugget.git
cd nugget
npm install
```

### Configuration

Create a `.env` file from the example:

```bash
cp .env.example .env
```

Then fill in your values:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_TOKEN` | Yes | - | Telegram bot token from @BotFather |
| `OWNER_ID` | Yes | - | Your Telegram user ID |
| `DB_PATH` | No | `./data/nugget.db` | SQLite database path |
| `COMMAND_ALLOWLIST` | No | - | Comma-separated allowed commands |
| `MAX_SESSIONS` | No | `3` | Maximum concurrent sessions |
| `NUGGET_RUNTIME` | No | `sandbox` | Runtime mode: "sandbox" or "container" |

### Running

Build and link the CLI:

```bash
npm run build
npm link
```

Start a named session:

```bash
nugget start my-project
```

Start a second session (becomes secondary, bridges to primary via IPC):

```bash
nugget start my-other-project
```

For development with watch mode:

```bash
npm run dev
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and quick start |
| `/hub` | Show sessions hub with controls |
| `/settings` | Configure notifications, enter confirmation, cycle limit |
| `/help` | Command reference |

Any text message sent to the bot is forwarded to the active session as input.

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
├── terminal/      # Terminal emulation layer
└── index.ts       # Entry point — wires all modules
test/              # Unit/integration tests
```

**Output pipeline:** PTY -> Terminal Emulator -> Screen Capture -> Telegram Output

The system uses a primary/secondary instance model. The primary instance owns the Telegram bot and IPC server. Secondary instances connect via TCP IPC and bridge their PTY output through the primary for Telegram display.

## Multi-Session Support

Run multiple `nugget start <name>` commands to create concurrent sessions. The first instance becomes the primary (controls the Telegram bot). Additional instances become secondary (headless, bridged to primary via IPC). If the primary exits, a secondary is automatically promoted to take over the Telegram bot.

## Development

```bash
npm run dev        # Watch mode (tsx)
npm run build      # Compile TypeScript
npm test           # Run tests
npm run lint       # Lint with ESLint
```

## Stack

- **Runtime:** Node.js, TypeScript (ESM)
- **Bot framework:** [grammY](https://grammy.dev/) (Telegram Bot API)
- **Database:** SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- **Terminal emulation:** [@xterm/headless](https://www.npmjs.com/package/@xterm/headless)
- **PTY:** [node-pty](https://github.com/microsoft/node-pty)
- **CLI:** [Commander](https://github.com/tj/commander.js)

## License

MIT
