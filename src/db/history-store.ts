import type Database from 'better-sqlite3';
import { logDebug, logInfo } from '../logging/logger.js';

export interface HistoryRecord {
  id: number;
  orchestratorSession: string;
  workerSession: string;
  taskDescription: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  cycleCount: number;
  outcome: 'done' | 'error' | 'stopped';
}

/** Persists completed automation history in SQLite for later retrieval. */
export class HistoryStore {
  constructor(private readonly db: Database.Database) {}

  /** Insert a completed automation record into history. */
  insert(record: Omit<HistoryRecord, 'id'>): void {
    logDebug(`[history-store] insert(worker='${record.workerSession}', outcome='${record.outcome}', cycles=${record.cycleCount})`);

    this.db.prepare(
      `INSERT INTO automation_history (orchestrator_session, worker_session, task_description, start_time, end_time, duration_ms, cycle_count, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.orchestratorSession,
      record.workerSession,
      record.taskDescription,
      record.startTime,
      record.endTime,
      record.durationMs,
      record.cycleCount,
      record.outcome,
    );
  }

  /** Load all history records, newest first. */
  loadAll(): HistoryRecord[] {
    logDebug('[history-store] loadAll()');

    const rows = this.db.prepare('SELECT * FROM automation_history ORDER BY end_time DESC').all() as Array<{
      id: number;
      orchestrator_session: string;
      worker_session: string;
      task_description: string;
      start_time: number;
      end_time: number;
      duration_ms: number;
      cycle_count: number;
      outcome: string;
    }>;

    logInfo(`[history-store] Loaded ${rows.length} history record(s)`);
    return rows.map((row) => ({
      id: row.id,
      orchestratorSession: row.orchestrator_session,
      workerSession: row.worker_session,
      taskDescription: row.task_description,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMs: row.duration_ms,
      cycleCount: row.cycle_count,
      outcome: row.outcome as HistoryRecord['outcome'],
    }));
  }

  /** Remove all history records. */
  clearAll(): void {
    logDebug('[history-store] clearAll()');
    this.db.prepare('DELETE FROM automation_history').run();
  }

  /** Remove a single history record by ID. Returns true if a record was deleted. */
  deleteById(id: number): boolean {
    logDebug(`[history-store] deleteById(${id})`);
    const result = this.db.prepare('DELETE FROM automation_history WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
