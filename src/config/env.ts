export interface AppConfig {
  botToken: string;
  ownerId: number;
  dbPath: string;
  commandAllowlist: string | undefined;
  maxSessions: number;
}

export function loadConfig(): AppConfig {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    throw new Error('BOT_TOKEN is required');
  }

  const ownerIdStr = process.env.OWNER_ID;
  if (!ownerIdStr) {
    throw new Error('OWNER_ID is required');
  }

  const ownerId = parseInt(ownerIdStr, 10);
  if (isNaN(ownerId)) {
    throw new Error('OWNER_ID must be a number');
  }

  const dbPath = process.env.DB_PATH ?? './data/nugget.db';

  const commandAllowlist = process.env.COMMAND_ALLOWLIST;

  const maxSessionsStr = process.env.MAX_SESSIONS;
  let maxSessions = 3;
  if (maxSessionsStr !== undefined) {
    maxSessions = parseInt(maxSessionsStr, 10);
    if (isNaN(maxSessions) || maxSessions < 1) {
      throw new Error('MAX_SESSIONS must be a positive integer');
    }
  }

  return { botToken, ownerId, dbPath, commandAllowlist, maxSessions };
}
