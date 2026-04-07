import { DatabaseSync } from "node:sqlite";
import type {
  ActivityPayload,
  ActivityRecord,
  AnalyticsEventRecord,
  ApprovalRecord,
  DaemonConfig,
  RecentWorkRecord,
  SessionDetail,
  SessionRecord,
  SummaryCacheRecord,
  StatsSnapshot,
  TerminalChunkRecord,
  TaskRecord,
} from "../domain.ts";
import { parseJsonSafe } from "../utils/json.ts";

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }

  return parseJsonSafe(value, fallback);
}

function toFlag(value: boolean): number {
  return value ? 1 : 0;
}

export class AsynqAgentdStorage {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        title TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        project_path TEXT NOT NULL,
        branch TEXT,
        state TEXT NOT NULL,
        adapter TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        project_path TEXT NOT NULL,
        branch TEXT,
        priority TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        approval_required INTEGER NOT NULL,
        model_preference TEXT,
        schedule TEXT,
        context_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        assigned_session_id TEXT,
        next_run_at TEXT,
        last_run_at TEXT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        context TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daemon_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recent_work (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        project_path TEXT,
        title TEXT NOT NULL,
        summary TEXT,
        source_type TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS terminal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        stream TEXT NOT NULL,
        chunk TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS summary_cache (
        key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        session_id TEXT,
        input_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        content_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analytics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        properties_json TEXT
      );
    `);

    this.ensureColumn("tasks", "next_run_at", "TEXT");
    this.ensureColumn("tasks", "last_run_at", "TEXT");
  }

  close(): void {
    this.db.close();
  }

  listSessions(): SessionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      ORDER BY updated_at DESC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapSession(row));
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  getSessionDetail(id: string): SessionDetail | undefined {
    const session = this.getSession(id);
    if (!session) {
      return undefined;
    }

    return {
      ...session,
      task: session.task_id ? this.getTask(session.task_id) : undefined,
      recent_events: this.listActivity({ session_id: id, limit: 25 }),
    };
  }

  upsertSession(session: SessionRecord): SessionRecord {
    this.db.prepare(`
      INSERT INTO sessions (id, task_id, title, agent_type, project_path, branch, state, adapter, created_at, updated_at, metadata_json)
      VALUES (@id, @task_id, @title, @agent_type, @project_path, @branch, @state, @adapter, @created_at, @updated_at, @metadata_json)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        title = excluded.title,
        agent_type = excluded.agent_type,
        project_path = excluded.project_path,
        branch = excluded.branch,
        state = excluded.state,
        adapter = excluded.adapter,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run({
      id: session.id,
      task_id: session.task_id ?? null,
      title: session.title,
      agent_type: session.agent_type,
      project_path: session.project_path,
      branch: session.branch ?? null,
      state: session.state,
      adapter: session.adapter,
      created_at: session.created_at,
      updated_at: session.updated_at,
      metadata_json: JSON.stringify(session.metadata ?? {}),
    });

    return session;
  }

  listTasks(): TaskRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 4
          WHEN 'high' THEN 3
          WHEN 'normal' THEN 2
          ELSE 1
        END DESC,
        created_at ASC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapTask(row));
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM tasks
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapTask(row) : undefined;
  }

  upsertTask(task: TaskRecord): TaskRecord {
    this.db.prepare(`
      INSERT INTO tasks (
        id, title, description, agent_type, project_path, branch, priority, depends_on_json,
        approval_required, model_preference, schedule, context_json, status, created_at, updated_at, assigned_session_id, next_run_at, last_run_at
      )
      VALUES (
        @id, @title, @description, @agent_type, @project_path, @branch, @priority, @depends_on_json,
        @approval_required, @model_preference, @schedule, @context_json, @status, @created_at, @updated_at, @assigned_session_id, @next_run_at, @last_run_at
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        agent_type = excluded.agent_type,
        project_path = excluded.project_path,
        branch = excluded.branch,
        priority = excluded.priority,
        depends_on_json = excluded.depends_on_json,
        approval_required = excluded.approval_required,
        model_preference = excluded.model_preference,
        schedule = excluded.schedule,
        context_json = excluded.context_json,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        assigned_session_id = excluded.assigned_session_id,
        next_run_at = excluded.next_run_at,
        last_run_at = excluded.last_run_at
    `).run({
      id: task.id,
      title: task.title,
      description: task.description,
      agent_type: task.agent_type,
      project_path: task.project_path,
      branch: task.branch ?? null,
      priority: task.priority,
      depends_on_json: JSON.stringify(task.depends_on),
      approval_required: toFlag(task.approval_required),
      model_preference: task.model_preference ?? null,
      schedule: task.schedule ?? null,
      context_json: JSON.stringify(task.context ?? {}),
      status: task.status,
      created_at: task.created_at,
      updated_at: task.updated_at,
      assigned_session_id: task.assigned_session_id ?? null,
      next_run_at: task.next_run_at ?? null,
      last_run_at: task.last_run_at ?? null,
    });

    return task;
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM tasks
      WHERE id = ?
    `).run(id);
    return result.changes > 0;
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM sessions
      WHERE id = ?
    `).run(id);
    return result.changes > 0;
  }

  deleteApprovalsForSession(sessionId: string): void {
    this.db.prepare(`
      DELETE FROM approvals
      WHERE session_id = ?
    `).run(sessionId);
  }

  deleteActivityForSession(sessionId: string): void {
    this.db.prepare(`
      DELETE FROM activity_events
      WHERE session_id = ?
    `).run(sessionId);
  }

  deleteTerminalEventsForSession(sessionId: string): void {
    this.db.prepare(`
      DELETE FROM terminal_events
      WHERE session_id = ?
    `).run(sessionId);
  }

  deleteSummaryCacheForSession(sessionId: string): void {
    this.db.prepare(`
      DELETE FROM summary_cache
      WHERE session_id = ?
    `).run(sessionId);
  }

  insertAnalyticsEvent(event: Omit<AnalyticsEventRecord, "id">): AnalyticsEventRecord {
    const result = this.db.prepare(`
      INSERT INTO analytics_events (name, source, created_at, properties_json)
      VALUES (?, ?, ?, ?)
    `).run(
      event.name,
      event.source,
      event.created_at,
      event.properties ? JSON.stringify(event.properties) : null,
    );

    return {
      id: Number(result.lastInsertRowid),
      ...event,
    };
  }

  listAnalyticsEvents(limit = 100): AnalyticsEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM analytics_events
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      source: String(row.source) as AnalyticsEventRecord["source"],
      created_at: String(row.created_at),
      properties: parseJson<Record<string, unknown>>(row.properties_json, {}),
    }));
  }

  listApprovals(status?: ApprovalRecord["status"]): ApprovalRecord[] {
    const rows = status
      ? (this.db.prepare(`
          SELECT * FROM approvals
          WHERE status = ?
          ORDER BY created_at ASC
        `).all(status) as Record<string, unknown>[])
      : (this.db.prepare(`
          SELECT * FROM approvals
          ORDER BY created_at ASC
        `).all() as Record<string, unknown>[]);
    return rows.map((row) => this.mapApproval(row));
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM approvals
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapApproval(row) : undefined;
  }

  upsertApproval(approval: ApprovalRecord): ApprovalRecord {
    this.db.prepare(`
      INSERT INTO approvals (id, session_id, action, context, status, note, created_at, updated_at)
      VALUES (@id, @session_id, @action, @context, @status, @note, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        action = excluded.action,
        context = excluded.context,
        status = excluded.status,
        note = excluded.note,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run({
      ...approval,
      note: approval.note ?? null,
    });

    return approval;
  }

  insertActivity(sessionId: string, createdAt: string, payload: ActivityPayload): ActivityRecord {
    const result = this.db.prepare(`
      INSERT INTO activity_events (session_id, created_at, type, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, createdAt, payload.type, JSON.stringify(payload));

    return {
      id: Number(result.lastInsertRowid),
      session_id: sessionId,
      created_at: createdAt,
      payload,
    };
  }

  listActivity(filters: { session_id?: string; type?: string; limit?: number } = {}): ActivityRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filters.session_id) {
      clauses.push("session_id = ?");
      params.push(filters.session_id);
    }

    if (filters.type) {
      clauses.push("type = ?");
      params.push(filters.type);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = filters.limit ? `LIMIT ${Number(filters.limit)}` : "";

    const rows = this.db.prepare(`
      SELECT * FROM activity_events
      ${whereClause}
      ORDER BY id DESC
      ${limitClause}
    `).all(...params) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row.id),
      session_id: String(row.session_id),
      created_at: String(row.created_at),
      payload: parseJson<ActivityPayload>(row.payload_json, {
        type: "error",
        message: "Failed to decode event payload",
        recoverable: true,
      }),
    }));
  }

  insertTerminalEvent(sessionId: string, createdAt: string, stream: TerminalChunkRecord["stream"], chunk: string): TerminalChunkRecord {
    const result = this.db.prepare(`
      INSERT INTO terminal_events (session_id, created_at, stream, chunk)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, createdAt, stream, chunk);

    return {
      id: Number(result.lastInsertRowid),
      session_id: sessionId,
      created_at: createdAt,
      stream,
      chunk,
    };
  }

  listTerminalEvents(sessionId: string, limit = 100): TerminalChunkRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM terminal_events
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(sessionId, limit) as Record<string, unknown>[];

    return rows.reverse().map((row) => ({
      id: Number(row.id),
      session_id: String(row.session_id),
      created_at: String(row.created_at),
      stream: String(row.stream) as TerminalChunkRecord["stream"],
      chunk: String(row.chunk),
    }));
  }

  trimTerminalEvents(sessionId: string, keep = 500): void {
    this.db.prepare(`
      DELETE FROM terminal_events
      WHERE session_id = ?
        AND id NOT IN (
          SELECT id FROM terminal_events
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT ?
        )
    `).run(sessionId, sessionId, keep);
  }

  getConfig(): DaemonConfig | undefined {
    const row = this.db.prepare(`
      SELECT value_json FROM daemon_config
      WHERE key = 'daemon'
    `).get() as { value_json?: string } | undefined;
    return row?.value_json ? parseJson<DaemonConfig>(row.value_json, undefined as never) : undefined;
  }

  saveConfig(config: DaemonConfig): DaemonConfig {
    this.db.prepare(`
      INSERT INTO daemon_config (key, value_json)
      VALUES ('daemon', ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `).run(JSON.stringify(config));
    return config;
  }

  getSummaryCache(key: string): SummaryCacheRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM summary_cache
      WHERE key = ?
    `).get(key) as Record<string, unknown> | undefined;
    return row ? this.mapSummaryCache(row) : undefined;
  }

  upsertSummaryCache(record: SummaryCacheRecord): SummaryCacheRecord {
    this.db.prepare(`
      INSERT INTO summary_cache (
        key, scope, entity_id, session_id, input_hash, provider, content_json, updated_at
      )
      VALUES (
        @key, @scope, @entity_id, @session_id, @input_hash, @provider, @content_json, @updated_at
      )
      ON CONFLICT(key) DO UPDATE SET
        scope = excluded.scope,
        entity_id = excluded.entity_id,
        session_id = excluded.session_id,
        input_hash = excluded.input_hash,
        provider = excluded.provider,
        content_json = excluded.content_json,
        updated_at = excluded.updated_at
    `).run({
      key: record.key,
      scope: record.scope,
      entity_id: record.entity_id,
      session_id: record.session_id ?? null,
      input_hash: record.input_hash,
      provider: record.provider,
      content_json: JSON.stringify(record.content ?? {}),
      updated_at: record.updated_at,
    });

    return record;
  }

  getStats(): StatsSnapshot {
    const sessionsTotal = this.scalar("SELECT COUNT(*) FROM sessions");
    const sessionsActive = this.scalar("SELECT COUNT(*) FROM sessions WHERE state IN ('idle', 'working', 'waiting_approval')");
    const tasksTotal = this.scalar("SELECT COUNT(*) FROM tasks");
    const tasksCompleted = this.scalar("SELECT COUNT(*) FROM tasks WHERE status = 'completed'");
    const tasksFailed = this.scalar("SELECT COUNT(*) FROM tasks WHERE status = 'failed'");
    const approvalsPending = this.scalar("SELECT COUNT(*) FROM approvals WHERE status = 'pending'");
    const modelCosts = this.db.prepare(`
      SELECT payload_json FROM activity_events
      WHERE type = 'model_call'
    `).all() as { payload_json: string }[];

    const model_cost_usd = modelCosts.reduce((sum, row) => {
      const payload = parseJson<{ cost_usd?: number }>(row.payload_json, {});
      return sum + Number(payload.cost_usd ?? 0);
    }, 0);

    return {
      sessions_total: sessionsTotal,
      sessions_active: sessionsActive,
      tasks_total: tasksTotal,
      tasks_completed: tasksCompleted,
      tasks_failed: tasksFailed,
      approvals_pending: approvalsPending,
      model_cost_usd,
    };
  }

  listRecentWork(): RecentWorkRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM recent_work
      ORDER BY updated_at DESC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRecentWork(row));
  }

  getRecentWork(id: string): RecentWorkRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM recent_work
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRecentWork(row) : undefined;
  }

  upsertRecentWork(record: RecentWorkRecord): RecentWorkRecord {
    this.db.prepare(`
      INSERT INTO recent_work (
        id, source_path, project_path, title, summary, source_type, status, updated_at, metadata_json
      )
      VALUES (
        @id, @source_path, @project_path, @title, @summary, @source_type, @status, @updated_at, @metadata_json
      )
      ON CONFLICT(id) DO UPDATE SET
        source_path = excluded.source_path,
        project_path = excluded.project_path,
        title = excluded.title,
        summary = excluded.summary,
        source_type = excluded.source_type,
        status = excluded.status,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run({
      id: record.id,
      source_path: record.source_path,
      project_path: record.project_path ?? null,
      title: record.title,
      summary: record.summary ?? null,
      source_type: record.source_type,
      status: record.status,
      updated_at: record.updated_at,
      metadata_json: JSON.stringify(record.metadata ?? {}),
    });

    return record;
  }

  private scalar(query: string): number {
    const row = this.db.prepare(query).get() as Record<string, unknown>;
    const value = Object.values(row)[0];
    return Number(value ?? 0);
  }

  private mapSession(row: Record<string, unknown>): SessionRecord {
    return {
      id: String(row.id),
      task_id: typeof row.task_id === "string" ? row.task_id : undefined,
      title: String(row.title),
      agent_type: row.agent_type as SessionRecord["agent_type"],
      project_path: String(row.project_path),
      branch: typeof row.branch === "string" ? row.branch : undefined,
      state: row.state as SessionRecord["state"],
      adapter: String(row.adapter),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    };
  }

  private mapTask(row: Record<string, unknown>): TaskRecord {
    return {
      id: String(row.id),
      title: String(row.title),
      description: String(row.description),
      agent_type: row.agent_type as TaskRecord["agent_type"],
      project_path: String(row.project_path),
      branch: typeof row.branch === "string" ? row.branch : undefined,
      priority: row.priority as TaskRecord["priority"],
      depends_on: parseJson<string[]>(row.depends_on_json, []),
      approval_required: Number(row.approval_required) === 1,
      model_preference: typeof row.model_preference === "string" ? row.model_preference : undefined,
      schedule: typeof row.schedule === "string" ? row.schedule : undefined,
      context: parseJson<TaskRecord["context"]>(row.context_json, {}),
      status: row.status as TaskRecord["status"],
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      assigned_session_id: typeof row.assigned_session_id === "string" ? row.assigned_session_id : undefined,
      next_run_at: typeof row.next_run_at === "string" ? row.next_run_at : undefined,
      last_run_at: typeof row.last_run_at === "string" ? row.last_run_at : undefined,
    };
  }

  private mapSummaryCache(row: Record<string, unknown>): SummaryCacheRecord {
    return {
      key: String(row.key),
      scope: row.scope as SummaryCacheRecord["scope"],
      entity_id: String(row.entity_id),
      session_id: typeof row.session_id === "string" ? row.session_id : undefined,
      input_hash: String(row.input_hash),
      provider: String(row.provider),
      content: parseJson<Record<string, unknown>>(row.content_json, {}),
      updated_at: String(row.updated_at),
    };
  }

  private mapApproval(row: Record<string, unknown>): ApprovalRecord {
    return {
      id: String(row.id),
      session_id: String(row.session_id),
      action: String(row.action),
      context: String(row.context),
      status: row.status as ApprovalRecord["status"],
      note: typeof row.note === "string" ? row.note : undefined,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  private mapRecentWork(row: Record<string, unknown>): RecentWorkRecord {
    return {
      id: String(row.id),
      source_path: String(row.source_path),
      project_path: typeof row.project_path === "string" ? row.project_path : undefined,
      title: String(row.title),
      summary: typeof row.summary === "string" ? row.summary : undefined,
      source_type: row.source_type as RecentWorkRecord["source_type"],
      status: row.status as RecentWorkRecord["status"],
      updated_at: String(row.updated_at),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    };
  }

  private ensureColumn(table: string, column: string, type: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch {
      // Column already exists in an initialized local DB.
    }
  }
}
