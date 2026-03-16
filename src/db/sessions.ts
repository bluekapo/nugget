import type Database from 'better-sqlite3';
import type { Session, SessionStatus } from '../session/types.js';

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
    const row = this.insertStmt.get(name) as SessionRow;
    return rowToSession(row);
  }

  findByName(name: string): Session | null {
    const row = this.findByNameStmt.get(name) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  updateStatus(name: string, status: SessionStatus): void {
    this.updateStatusStmt.run(status, name);
  }

  updatePid(name: string, pid: number): void {
    this.updatePidStmt.run(pid, name);
  }

  getActive(): Session[] {
    const rows = this.getActiveStmt.all() as SessionRow[];
    return rows.map(rowToSession);
  }

  delete(name: string): void {
    this.deleteStmt.run(name);
  }

  /** Delete stale session records (crash recovery). Only deletes rows whose PID is dead or null.
   *  Preserves rows for PIDs that are still alive (e.g. another running instance). */
  cleanupStale(): number {
    const rows = this.getStaleStmt.all() as SessionRow[];
    let deleted = 0;
    for (const row of rows) {
      if (row.pid != null && isPidAlive(row.pid)) {
        // PID is alive — this session belongs to another running process, skip it
        continue;
      }
      this.deleteByIdStmt.run(row.id);
      deleted++;
    }
    return deleted;
  }
}
