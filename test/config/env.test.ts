import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Will be implemented in env.ts
import { loadConfig } from '../../src/config/env.js';
import type { AppConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.BOT_TOKEN;
    delete process.env.OWNER_ID;
    delete process.env.DB_PATH;
    delete process.env.COMMAND_ALLOWLIST;
    delete process.env.MAX_SESSIONS;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  it('throws if BOT_TOKEN is missing', () => {
    process.env.OWNER_ID = '12345';

    assert.throws(
      () => loadConfig(),
      { message: 'BOT_TOKEN is required' }
    );
  });

  it('throws if OWNER_ID is missing', () => {
    process.env.BOT_TOKEN = 'test-token';

    assert.throws(
      () => loadConfig(),
      { message: 'OWNER_ID is required' }
    );
  });

  it('throws if OWNER_ID is not a valid number', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.OWNER_ID = 'not-a-number';

    assert.throws(
      () => loadConfig(),
      { message: 'OWNER_ID must be a number' }
    );
  });

  it('returns typed AppConfig with botToken, ownerId (number), dbPath', () => {
    process.env.BOT_TOKEN = 'test-token-123';
    process.env.OWNER_ID = '67890';
    process.env.DB_PATH = '/custom/path.db';

    const config: AppConfig = loadConfig();

    assert.equal(config.botToken, 'test-token-123');
    assert.equal(config.ownerId, 67890);
    assert.equal(typeof config.ownerId, 'number');
    assert.equal(config.dbPath, '/custom/path.db');
  });

  it('uses default DB_PATH of "./data/ccr.db" when not set', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.OWNER_ID = '12345';

    const config = loadConfig();

    assert.equal(config.dbPath, './data/ccr.db');
  });

  it('returns commandAllowlist from COMMAND_ALLOWLIST env var', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.OWNER_ID = '12345';
    process.env.COMMAND_ALLOWLIST = '/clear,/compact,y,n';

    const config = loadConfig();

    assert.equal(config.commandAllowlist, '/clear,/compact,y,n');
  });

  it('returns undefined for commandAllowlist when COMMAND_ALLOWLIST is not set', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.OWNER_ID = '12345';

    const config = loadConfig();

    assert.equal(config.commandAllowlist, undefined);
  });

  it('returns maxSessions default of 3 when MAX_SESSIONS is not set', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.OWNER_ID = '12345';

    const config = loadConfig();

    assert.equal(config.maxSessions, 3);
  });

  it('parses MAX_SESSIONS from env var', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.OWNER_ID = '12345';
    process.env.MAX_SESSIONS = '5';

    const config = loadConfig();

    assert.equal(config.maxSessions, 5);
  });

  it('throws if MAX_SESSIONS is not a valid positive integer', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.OWNER_ID = '12345';
    process.env.MAX_SESSIONS = 'abc';

    assert.throws(
      () => loadConfig(),
      { message: 'MAX_SESSIONS must be a positive integer' },
    );
  });

  it('throws if MAX_SESSIONS is zero', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.OWNER_ID = '12345';
    process.env.MAX_SESSIONS = '0';

    assert.throws(
      () => loadConfig(),
      { message: 'MAX_SESSIONS must be a positive integer' },
    );
  });

  it('throws if MAX_SESSIONS is negative', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.OWNER_ID = '12345';
    process.env.MAX_SESSIONS = '-1';

    assert.throws(
      () => loadConfig(),
      { message: 'MAX_SESSIONS must be a positive integer' },
    );
  });
});
