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

export class SessionStore {
  private insertStmt: Database.Statement;
  private findByNameStmt: Database.Statement;
  private updateStatusStmt: Database.Statement;
  private updatePidStmt: Database.Statement;
  private getActiveStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private cleanupStaleStmt: Database.Statement;

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

    this.cleanupStaleStmt = db.prepare(
      `DELETE FROM sessions WHERE status IN ('starting', 'running', 'stopping')`
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

  /** Delete all records with status starting/running/stopping (crash recovery). Returns count of deleted rows. */
  cleanupStale(): number {
    const result = this.cleanupStaleStmt.run();
    return result.changes;
  }
}
