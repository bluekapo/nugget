<div align="center">

<img src="docs/assets/nugget.jpg" alt="Nugget" width="128" />

# Nugget

**Run AI tasks while you sleep, walk, run, jump, or do anything other than sitting in front of your computer.**

</div>

---

## What is Nugget?

Nugget is a Node.js framework that spawns Claude Code inside Docker sandboxes, mirrors terminal output to Telegram, accepts commands back via text and inline buttons, and manages concurrent named sessions with a central hub. Use it to monitor and control long-running Claude Code sessions from your phone.

## Features

- Real-time terminal output mirrored to Telegram
- Send text input and use inline buttons (approve, reject, scroll, navigate)
- Multi-session support with a central hub
- Session switching and concurrent named sessions
- Scroll lock for browsing output while streaming continues
- Prompt completion notifications
- Configurable settings via /settings
- Primary/secondary instance architecture with automatic promotion
- Command allowlist for security

## Prerequisites

- Node.js (LTS recommended)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))
- Docker (if running Claude Code in sandboxes)

## Installation

```bash
git clone https://github.com/AshGw/nugget.git
cd nugget
npm install
```

## Configuration

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

## Usage

```bash
# Development (watch mode)
npm run dev

# Production
npm run build
npm start

# Start a named session
npx nugget start my-project
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and quick start |
| `/hub` | Show sessions hub with switch/kill buttons |
| `/controls` | Show session control buttons |
| `/settings` | Configure notifications |
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
