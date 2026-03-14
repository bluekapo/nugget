import type Database from 'better-sqlite3';

export interface PersistedAutomation {
  id: number;
  workerSession: string;
  orchestratorSession: string;
  taskDescription: string;
  engineState: string;
  cycleCount: number;
  lastAction: string | null;
  actionLog: Array<{ action: string; outcome: string; timestamp: number }>;
  startTime: number;
}

/** Persists active automation state in SQLite for crash recovery and promotion. */
export class AutomationStore {
  constructor(private readonly db: Database.Database) {}

  /** Insert or update an automation record (upsert by id). */
  save(auto: PersistedAutomation): void {
    this.db.prepare(
      `INSERT INTO automations (id, worker_session, orchestrator_session, task_description, engine_state, cycle_count, last_action, action_log_json, start_time, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         worker_session = excluded.worker_session,
         orchestrator_session = excluded.orchestrator_session,
         task_description = excluded.task_description,
         engine_state = excluded.engine_state,
         cycle_count = excluded.cycle_count,
         last_action = excluded.last_action,
         action_log_json = excluded.action_log_json,
         start_time = excluded.start_time,
         updated_at = excluded.updated_at`
    ).run(
      auto.id,
      auto.workerSession,
      auto.orchestratorSession,
      auto.taskDescription,
      auto.engineState,
      auto.cycleCount,
      auto.lastAction,
      JSON.stringify(auto.actionLog),
      auto.startTime,
    );
  }

  /** Load all persisted automation records. */
  loadAll(): PersistedAutomation[] {
    const rows = this.db.prepare('SELECT * FROM automations').all() as Array<{
      id: number;
      worker_session: string;
      orchestrator_session: string;
      task_description: string;
      engine_state: string;
      cycle_count: number;
      last_action: string | null;
      action_log_json: string;
      start_time: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      workerSession: row.worker_session,
      orchestratorSession: row.orchestrator_session,
      taskDescription: row.task_description,
      engineState: row.engine_state,
      cycleCount: row.cycle_count,
      lastAction: row.last_action,
      actionLog: JSON.parse(row.action_log_json),
      startTime: row.start_time,
    }));
  }

  /** Remove a single automation record by id. */
  remove(id: number): void {
    this.db.prepare('DELETE FROM automations WHERE id = ?').run(id);
  }

  /** Remove all automation records. */
  clearAll(): void {
    this.db.prepare('DELETE FROM automations').run();
  }
}
