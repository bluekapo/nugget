import type Database from 'better-sqlite3';
import type { Session, SessionStatus } from '../session/types.js';
import { logDebug, logInfo, logWarn } from '../logging/logger.js';

interface SessionRow {
  id: number;
  name: string;
  pid: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    pid: row.pid,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Check if a PID is alive using signal 0 probe. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class SessionStore {
  private insertStmt: Database.Statement;
  private findByNameStmt: Database.Statement;
  private updateStatusStmt: Database.Statement;
  private updatePidStmt: Database.Statement;
  private getActiveStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private getStaleStmt: Database.Statement;
  private deleteByIdStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO sessions (name) VALUES (?) RETURNING *`
    );

    this.findByNameStmt = db.prepare(
      `SELECT * FROM sessions WHERE name = ?`
    );

    this.updateStatusStmt = db.prepare(
      `UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE name = ?`
    );

    this.updatePidStmt = db.prepare(
      `UPDATE sessions SET pid = ?, updated_at = datetime('now') WHERE name = ?`
    );

    this.getActiveStmt = db.prepare(
      `SELECT * FROM sessions WHERE status IN ('starting', 'running')`
    );

    this.deleteStmt = db.prepare(
      `DELETE FROM sessions WHERE name = ?`
    );

    this.getStaleStmt = db.prepare(
      `SELECT * FROM sessions WHERE status IN ('starting', 'running', 'stopping')`
    );

    this.deleteByIdStmt = db.prepare(
      `DELETE FROM sessions WHERE id = ?`
    );
  }

  create(name: string): Session {
    logDebug(`[sessions] Creating session record: ${name}`);
    const row = this.insertStmt.get(name) as SessionRow;
    logInfo(`[sessions] Session record created: ${name} (id=${row.id})`);
    return rowToSession(row);
  }

  findByName(name: string): Session | null {
    const row = this.findByNameStmt.get(name) as SessionRow | undefined;
    logDebug(`[sessions] findByName('${name}'): ${row ? `found (status=${row.status})` : 'not found'}`);
    return row ? rowToSession(row) : null;
  }

  updateStatus(name: string, status: SessionStatus): void {
    logDebug(`[sessions] updateStatus('${name}', '${status}')`);
    this.updateStatusStmt.run(status, name);
  }

  updatePid(name: string, pid: number): void {
    logDebug(`[sessions] updatePid('${name}', ${pid})`);
    this.updatePidStmt.run(pid, name);
  }

  getActive(): Session[] {
    const rows = this.getActiveStmt.all() as SessionRow[];
    logDebug(`[sessions] getActive(): ${rows.length} active session(s)`);
    return rows.map(rowToSession);
  }

  delete(name: string): void {
    logDebug(`[sessions] Deleting session record: ${name}`);
    this.deleteStmt.run(name);
  }

  /** Delete stale session records (crash recovery). Only deletes rows whose PID is dead or null.
   *  Preserves rows for PIDs that are still alive (e.g. another running instance). */
  cleanupStale(): number {
    const rows = this.getStaleStmt.all() as SessionRow[];
    logDebug(`[sessions] cleanupStale(): checking ${rows.length} potentially stale record(s)`);
    let deleted = 0;
    for (const row of rows) {
      if (row.pid != null && isPidAlive(row.pid)) {
        logDebug(`[sessions] Skipping stale check for '${row.name}' — PID ${row.pid} is alive`);
        continue;
      }
      logWarn(`[sessions] Removing stale session '${row.name}' (pid=${row.pid}, status=${row.status})`);
      this.deleteByIdStmt.run(row.id);
      deleted++;
    }
    return deleted;
  }
}
