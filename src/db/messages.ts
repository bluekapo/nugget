import type Database from 'better-sqlite3';

export interface MessageRow {
  id: number;
  session_name: string;
  telegram_message_id: number;
  content: string;
  sequence_num: number;
  status: string;
  created_at: string;
}

export class MessageStore {
  private insertStmt: Database.Statement;
  private getBySessionStmt: Database.Statement;
  private deleteBySessionStmt: Database.Statement;
  private updateStatusStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO messages (session_name, telegram_message_id, content, sequence_num) VALUES (?, ?, ?, ?)`
    );

    this.getBySessionStmt = db.prepare(
      `SELECT * FROM messages WHERE session_name = ? AND status IN ('active', 'persisted') ORDER BY sequence_num ASC`
    );

    this.deleteBySessionStmt = db.prepare(
      `DELETE FROM messages WHERE session_name = ?`
    );

    this.updateStatusStmt = db.prepare(
      `UPDATE messages SET status = ? WHERE session_name = ?`
    );
  }

  save(sessionName: string, telegramMessageId: number, content: string, sequenceNum: number): void {
    this.insertStmt.run(sessionName, telegramMessageId, content, sequenceNum);
  }

  getBySession(sessionName: string): MessageRow[] {
    return this.getBySessionStmt.all(sessionName) as MessageRow[];
  }

  deleteBySession(sessionName: string): void {
    this.deleteBySessionStmt.run(sessionName);
  }

  updateStatus(sessionName: string, status: string): void {
    this.updateStatusStmt.run(status, sessionName);
  }
}
