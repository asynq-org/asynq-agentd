import type { AsynqAgentdStorage } from "../db/storage.ts";
import type { ActivityPayload, ApprovalRecord, RecentWorkRecord, SessionRecord, TaskRecord } from "../domain.ts";
import { RecentWorkService } from "./recent-work-service.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import { nowIso } from "../utils/time.ts";
import { SummaryService } from "./summary-service.ts";
import { RuntimeDiscoveryService } from "./runtime-discovery-service.ts";

interface DashboardServiceOptions {
  storage: AsynqAgentdStorage;
  tasks: TaskService;
  sessions: SessionService;
  recentWork: RecentWorkService;
  summaries: SummaryService;
  runtimes: RuntimeDiscoveryService;
}

export class DashboardService {
  private readonly storage: AsynqAgentdStorage;
  private readonly tasks: TaskService;
  private readonly sessions: SessionService;
  private readonly recentWork: RecentWorkService;
  private readonly summaries: SummaryService;
  private readonly runtimes: RuntimeDiscoveryService;

  constructor(options: DashboardServiceOptions) {
    this.storage = options.storage;
    this.tasks = options.tasks;
    this.sessions = options.sessions;
    this.recentWork = options.recentWork;
    this.summaries = options.summaries;
    this.runtimes = options.runtimes;
  }

  getOverview() {
    const sessions = this.sessions.list();
    const tasks = this.tasks.list();
    const approvals = this.storage.listApprovals("pending");
    const activeSessions = sessions.filter((session) => session.state === "working" || session.state === "waiting_approval");
    const runtimes = this.runtimes.list().filter((runtime) => runtime.available && runtime.id !== "custom" && runtime.mode === "real");
    const continueCount = this.getContinueWorking().items.length;

    return {
      generated_at: nowIso(),
      counts: {
        sessions_active: activeSessions.length,
        sessions_working: sessions.filter((session) => session.state === "working").length,
        approvals_pending: approvals.length,
        tasks_running: tasks.filter((task) => task.status === "running").length,
        tasks_paused: tasks.filter((task) => task.status === "paused").length,
        runtimes_ready: runtimes.length,
        continue_working: continueCount,
      },
      runtimes,
    };
  }

  getManagedSessions() {
    const sessions = this.sessions.list();
    const activeSessions = sessions.filter((session) => session.state === "working" || session.state === "waiting_approval");
    return {
      generated_at: nowIso(),
      items: activeSessions.map((session) => this.toSessionCard(session)),
    };
  }

  getAttentionRequired() {
    const approvals = this.storage.listApprovals("pending");
    return {
      generated_at: nowIso(),
      items: approvals.map((approval) => this.toApprovalCard(approval)),
    };
  }

  getApprovalDetail(id: string) {
    const approval = this.storage.getApproval(id);
    if (!approval) {
      return undefined;
    }

    return this.toApprovalCard(approval);
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
        summary: this.summaries.getSessionCardSummary(session, this.summarizeSession(session)),
        next_action: session.state === "waiting_approval" ? "review_approval" : "open_session",
      }));
    const recentRecords = this.recentWork.list();

    const recentItems = recentRecords
      .filter((record) => !activeOrPaused.some((session) => session.session_id === record.id))
      .filter((record) => this.shouldIncludeRecentWork(record))
      .slice(0, 10)
      .map((record) => {
        const summarized = this.summaries.readContinueCard(
          record,
          this.summarizeRecentWorkTitle(record),
          this.summarizeRecentWorkForContinue(record),
        );
        return {
          kind: "recent_work" as const,
          recent_work_id: record.id,
          title: summarized.title,
          source_type: record.source_type,
          status: record.status,
          project_path: record.project_path,
          summary: summarized.summary,
          next_action: summarized.nextMove ?? "continue_recent_work",
        };
      });

    return {
      generated_at: nowIso(),
      items: [...activeOrPaused, ...recentItems].slice(0, 12),
    };
  }

  getRecentWorkDetail(id: string) {
    const record = this.storage.getRecentWork(id);
    if (!record) {
      return undefined;
    }

    const metadata = record.metadata ?? {};
    const fallbackTitle = this.summarizeRecentWorkTitle(record);
    const fallbackSummary = this.summarizeRecentWorkForContinue(record);
    const summarized = this.summaries.readContinueCard(record, fallbackTitle, fallbackSummary);

    return {
      id: record.id,
      title: summarized.title,
      project_path: record.project_path,
      project: this.projectName(record.project_path ?? "Linked project"),
      source_type: record.source_type,
      status: record.status,
      summary: summarized.summary,
      raw_agent_response: this.pickString(
        metadata.raw_agent_response,
        metadata.last_agent_message,
        metadata.last_assistant_message,
      ),
      next_move: summarized.nextMove,
      changed_files: Array.isArray(metadata.changed_files)
        ? metadata.changed_files.filter((value): value is string => typeof value === "string")
        : [],
      updated_at: record.updated_at,
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
      summary: this.summaries.getSessionCardSummary(session, this.summarizeSession(session)),
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
    const review = session ? this.buildApprovalReview(session, task, approval) : undefined;
    return {
      approval_id: approval.id,
      session_id: approval.session_id,
      task_id: task?.id,
      title: task?.title ?? session?.title ?? approval.action,
      action: approval.action,
      context: approval.context,
      agent_type: session?.agent_type,
      project_path: session?.project_path,
      summary: session ? this.summaries.getSessionCardSummary(session, this.summarizeSession(session)) : undefined,
      next_action: "approve_or_reject",
      created_at: approval.created_at,
      review,
    };
  }

  private buildApprovalReview(session: SessionRecord, task: TaskRecord | undefined, approval: ApprovalRecord) {
    const events = this.storage.listActivity({ session_id: session.id, limit: 20 });
    const drivingEvent = events.find((event) => this.isReviewPayload(event.payload))?.payload;
    const fileEntries = this.buildReviewFiles(drivingEvent, session.project_path);
    const linesAdded = fileEntries.reduce((total, file) => total + (file.lines_added ?? 0), 0);
    const linesRemoved = fileEntries.reduce((total, file) => total + (file.lines_removed ?? 0), 0);
    const canApproveAll = fileEntries.length > 1 || /files?/i.test(approval.action);

    return {
      machine: "Linked machine",
      agent: session.agent_type,
      branch: session.branch,
      project: this.projectName(session.project_path),
      review_hint: this.reviewHint(drivingEvent, approval),
      test_status: task?.context?.test_command
        ? `Suggested test command: ${task.context.test_command}`
        : "No explicit test command recorded for this task.",
      stats: {
        files_changed: fileEntries.length,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
      },
      suggested_actions: canApproveAll
        ? ["Approve", "Approve all", "Reject", "Custom reply"]
        : ["Approve", "Reject", "Custom reply"],
      command: this.extractCommand(drivingEvent),
      files: fileEntries,
    };
  }

  private buildReviewFiles(payload: ActivityPayload | undefined, projectPath: string) {
    if (!payload) {
      return [];
    }

    if (payload.type === "file_batch" || payload.type === "file_batch_intent") {
      return payload.files.map((file) => ({
        path: file.path,
        action: file.action,
        lines_added: file.action === "edited" ? file.lines_added : 0,
        lines_removed: file.action === "edited" ? file.lines_removed : 0,
        summary: file.action === "edited"
          ? `Edited ${this.projectRelativePath(projectPath, file.path)}`
          : file.action === "created"
            ? `Created ${this.projectRelativePath(projectPath, file.path)}`
            : `Deleted ${this.projectRelativePath(projectPath, file.path)}`,
        diff_preview: file.action === "edited"
          ? [
              `+${file.lines_added} lines`,
              `-${file.lines_removed} lines`,
            ]
          : [`${file.action} ${this.projectRelativePath(projectPath, file.path)}`],
      }));
    }

    return [];
  }

  private isReviewPayload(payload: ActivityPayload) {
    return payload.type === "file_batch_intent"
      || payload.type === "file_batch"
      || payload.type === "command_intent"
      || payload.type === "command_run";
  }

  private extractCommand(payload: ActivityPayload | undefined): string | undefined {
    if (!payload) {
      return undefined;
    }

    if (payload.type === "command_intent" || payload.type === "command_run") {
      return payload.cmd;
    }

    return undefined;
  }

  private reviewHint(payload: ActivityPayload | undefined, approval: ApprovalRecord): string {
    if (!payload) {
      return approval.context;
    }

    if (payload.type === "file_batch_intent" || payload.type === "file_batch") {
      return payload.summary;
    }

    if (payload.type === "command_intent" || payload.type === "command_run") {
      return `Review the command before approving: ${payload.cmd}`;
    }

    return approval.context;
  }

  private projectName(projectPath: string): string {
    const parts = projectPath.split(/[/\\]/).filter(Boolean);
    return parts.at(-1) ?? projectPath;
  }

  private projectRelativePath(projectPath: string, candidatePath: string): string {
    if (!candidatePath.startsWith(projectPath)) {
      return candidatePath;
    }

    return candidatePath.slice(projectPath.length).replace(/^[/\\]+/, "") || candidatePath;
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

  private summarizeRecentWorkForContinue(record: RecentWorkRecord): string {
    const metadata = record.metadata ?? {};
    const candidate = this.pickMeaningfulSummary(
      record.summary,
      metadata.last_agent_message,
      metadata.last_user_message,
    ) ?? this.pickMeaningfulText(
      metadata.last_reasoning_summary,
      record.summary,
    ) ?? this.summarizeRecentWork(record);
    return this.compactText(candidate);
  }

  private summarizeRecentWorkTitle(record: RecentWorkRecord): string {
    const metadata = record.metadata ?? {};
    const candidate = this.pickMeaningfulTitle(
      metadata.thread_name,
      metadata.summary_title,
      record.title,
      metadata.last_user_message,
      metadata.last_agent_message,
      metadata.last_reasoning_summary,
    );
    return this.compactTitle(candidate);
  }

  private shouldIncludeRecentWork(record: RecentWorkRecord): boolean {
    if (record.source_type === "claude-file") {
      return false;
    }

    if (!this.pickString(record.project_path)) {
      return false;
    }

    const summary = this.summarizeRecentWorkForContinue(record);

    if (!this.isMeaningfulText(summary)) {
      return false;
    }

    if (record.source_type === "codex-session-file" && !this.hasMeaningfulResumeSignal(record)) {
      return false;
    }

    return true;
  }
  private hasMeaningfulResumeSignal(record: RecentWorkRecord): boolean {
    const metadata = record.metadata ?? {};
    return Boolean(this.pickMeaningfulText(
      metadata.thread_name,
      metadata.last_reasoning_summary,
      metadata.last_agent_message,
      metadata.last_user_message,
      record.summary,
    ));
  }

  private pickMeaningfulTitle(...values: unknown[]): string {
    for (const value of values) {
      const picked = this.pickString(value);
      if (!picked || !this.isMeaningfulText(picked)) {
        continue;
      }

      const normalized = picked.replace(/\s+/g, " ").trim();
      if (normalized.length > 96) {
        continue;
      }

      if (/[.!?].{20,}[.!?]/.test(normalized) || /^\s*[-*]\s+/.test(normalized)) {
        continue;
      }

      return picked;
    }

    const heuristic = this.deriveHeuristicTitle(...values);
    if (heuristic) {
      return heuristic;
    }

    return "Recent work ready to continue";
  }

  private pickMeaningfulSummary(...values: unknown[]): string | undefined {
    for (const value of values) {
      const picked = this.pickString(value);
      if (!picked || !this.isMeaningfulText(picked)) {
        continue;
      }

      const heuristic = this.deriveHeuristicSummary(picked);
      if (heuristic) {
        return heuristic;
      }
    }

    return undefined;
  }

  private deriveHeuristicTitle(...values: unknown[]): string | undefined {
    for (const value of values) {
      const picked = this.pickString(value);
      if (!picked || !this.isMeaningfulText(picked)) {
        continue;
      }

      const firstLine = picked
        .split(/\n+/)
        .map((line) => line.trim())
        .find(Boolean);

      if (!firstLine) {
        continue;
      }

      const sentence = firstLine.split(/(?<=[.!?])\s+/)[0]?.trim() ?? firstLine;
      const candidate = sentence
        .replace(/^[-*]\s+/, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();

      if (!candidate || !this.isMeaningfulText(candidate)) {
        continue;
      }

      return candidate;
    }

    return undefined;
  }

  private deriveHeuristicSummary(text: string): string | undefined {
    const normalized = text
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\r/g, "")
      .trim();

    if (!normalized || !this.isMeaningfulText(normalized)) {
      return undefined;
    }

    const firstParagraph = normalized
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find(Boolean);

    if (!firstParagraph) {
      return undefined;
    }

    const flattened = firstParagraph
      .replace(/\n[-*]\s+/g, " ")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!flattened || !this.isMeaningfulText(flattened)) {
      return undefined;
    }

    const sentence = flattened.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").trim();
    return sentence || flattened;
  }

  private pickMeaningfulText(...values: unknown[]): string | undefined {
    for (const value of values) {
      const picked = this.pickString(value);
      if (picked && this.isMeaningfulText(picked)) {
        return picked;
      }
    }

    return undefined;
  }

  private isMeaningfulText(text: string): boolean {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return false;
    }

    if (normalized.length < 4) {
      return false;
    }

    if (/^[\[{(]+$/.test(normalized) || /^[\]}),.]+$/.test(normalized)) {
      return false;
    }

    if (/^gAAAAA[\w-]{12,}/.test(normalized)) {
      return false;
    }

    if (/^[{\[]/.test(normalized)) {
      return false;
    }

    if (/^continue (codex|claude code)$/i.test(normalized)) {
      return false;
    }

    if (/^continue recent work$/i.test(normalized)) {
      return false;
    }

    if (/^rewrite recent work into compact mobile cards for asynq buddy/i.test(normalized)) {
      return false;
    }

    if (/^(codex|claude code|login|auth|authenticate)$/i.test(normalized)) {
      return false;
    }

    if (/Could you clarify what you'd like to log in to/i.test(normalized)) {
      return false;
    }

    return true;
  }

  private compactText(text: string, maxLength = 160): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
  }

  private compactTitle(text: string, maxLength = 72): string {
    const normalized = text
      .replace(/\s+/g, " ")
      .replace(/^["'`\s]+|["'`\s]+$/g, "")
      .trim();

    if (normalized.length <= maxLength) {
      return normalized;
    }

    const slice = normalized.slice(0, maxLength - 1);
    const sentenceBoundary = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
    if (sentenceBoundary >= 18) {
      return slice.slice(0, sentenceBoundary).trim();
    }

    const wordBoundary = slice.lastIndexOf(" ");
    if (wordBoundary >= 18) {
      return `${slice.slice(0, wordBoundary).trimEnd()}…`;
    }

    return `${slice.trimEnd()}…`;
  }

  private pickString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
}
