import type { AsynqAgentdStorage } from "../db/storage.ts";
import type { ApprovalRecord, RecentWorkRecord, SessionRecord, TaskRecord } from "../domain.ts";
import { RecentWorkService } from "./recent-work-service.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import { nowIso } from "../utils/time.ts";

interface DashboardServiceOptions {
  storage: AsynqAgentdStorage;
  tasks: TaskService;
  sessions: SessionService;
  recentWork: RecentWorkService;
}

export class DashboardService {
  private readonly storage: AsynqAgentdStorage;
  private readonly tasks: TaskService;
  private readonly sessions: SessionService;
  private readonly recentWork: RecentWorkService;

  constructor(options: DashboardServiceOptions) {
    this.storage = options.storage;
    this.tasks = options.tasks;
    this.sessions = options.sessions;
    this.recentWork = options.recentWork;
  }

  getOverview() {
    const sessions = this.sessions.list();
    const tasks = this.tasks.list();
    const approvals = this.storage.listApprovals("pending");
    const activeSessions = sessions.filter((session) => session.state === "working" || session.state === "waiting_approval");

    return {
      generated_at: nowIso(),
      counts: {
        sessions_active: activeSessions.length,
        sessions_working: sessions.filter((session) => session.state === "working").length,
        approvals_pending: approvals.length,
        tasks_running: tasks.filter((task) => task.status === "running").length,
        tasks_paused: tasks.filter((task) => task.status === "paused").length,
      },
      sessions: activeSessions.slice(0, 6).map((session) => this.toSessionCard(session)),
      attention_required: approvals.slice(0, 6).map((approval) => this.toApprovalCard(approval)),
      continue_working: this.getContinueWorking().items.slice(0, 6),
    };
  }

  getAttentionRequired() {
    const approvals = this.storage.listApprovals("pending");
    return {
      generated_at: nowIso(),
      items: approvals.map((approval) => this.toApprovalCard(approval)),
    };
  }

  getContinueWorking() {
    const sessions = this.sessions.list();
    const activeOrPaused = sessions
      .filter((session) => session.state === "working" || session.state === "waiting_approval")
      .map((session) => ({
        kind: "managed_session" as const,
        session_id: session.id,
        task_id: session.task_id,
        title: session.title,
        agent_type: session.agent_type,
        state: session.state,
        project_path: session.project_path,
        summary: this.summarizeSession(session),
        next_action: session.state === "waiting_approval" ? "review_approval" : "open_session",
      }));

    this.recentWork.scan();
    const recentItems = this.recentWork.list()
      .filter((record) => !activeOrPaused.some((session) => session.session_id === record.id))
      .slice(0, 10)
      .map((record) => ({
        kind: "recent_work" as const,
        recent_work_id: record.id,
        title: record.title,
        source_type: record.source_type,
        status: record.status,
        project_path: record.project_path,
        summary: record.summary ?? this.summarizeRecentWork(record),
        next_action: "continue_recent_work",
      }));

    return {
      generated_at: nowIso(),
      items: [...activeOrPaused, ...recentItems].slice(0, 12),
    };
  }

  private toSessionCard(session: SessionRecord) {
    const task = session.task_id ? this.tasks.get(session.task_id) : undefined;
    return {
      session_id: session.id,
      task_id: session.task_id,
      title: session.title,
      agent_type: session.agent_type,
      state: session.state,
      adapter: session.adapter,
      project_path: session.project_path,
      branch: session.branch,
      summary: this.summarizeSession(session),
      last_event: this.storage.listActivity({ session_id: session.id, limit: 1 })[0] ?? null,
      task_status: task?.status,
      terminal: {
        mode: this.pickString(session.metadata?.terminal_mode) ?? "pipe",
        transport: this.pickString(session.metadata?.terminal_transport) ?? "direct",
        size: session.metadata?.terminal_size ?? null,
      },
      updated_at: session.updated_at,
    };
  }

  private toApprovalCard(approval: ApprovalRecord) {
    const session = this.sessions.getRecord(approval.session_id);
    const task = session?.task_id ? this.tasks.get(session.task_id) : undefined;
    return {
      approval_id: approval.id,
      session_id: approval.session_id,
      task_id: task?.id,
      title: task?.title ?? session?.title ?? approval.action,
      action: approval.action,
      context: approval.context,
      agent_type: session?.agent_type,
      project_path: session?.project_path,
      summary: session ? this.summarizeSession(session) : undefined,
      next_action: "approve_or_reject",
      created_at: approval.created_at,
    };
  }

  private summarizeSession(session: SessionRecord): string {
    const recentEvents = this.storage.listActivity({ session_id: session.id, limit: 5 });
    const last = recentEvents[0]?.payload;

    if (!last) {
      return session.state === "waiting_approval"
        ? "Waiting for your approval."
        : "Session is running.";
    }

    if (last.type === "approval_requested") {
      return last.context;
    }

    if (last.type === "agent_thinking") {
      return last.summary;
    }

    if (last.type === "command_intent" || last.type === "command_run") {
      return `Working with command: ${last.cmd}`;
    }

    if (last.type === "file_batch_intent" || last.type === "file_batch") {
      return last.summary;
    }

    if (last.type === "error") {
      return last.message;
    }

    return session.state === "waiting_approval"
      ? "Waiting for your approval."
      : `Session is ${session.state}.`;
  }

  private summarizeRecentWork(record: RecentWorkRecord): string {
    if (record.status === "active") {
      return "Observed work is still active and can be resumed or monitored.";
    }

    if (record.status === "ended") {
      return "Observed work ended recently and can be continued.";
    }

    return "Recent work is available to continue.";
  }

  private pickString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
}
