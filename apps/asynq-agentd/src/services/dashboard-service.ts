import type { AsynqAgentdStorage } from "../db/storage.ts";
import type { ActivityPayload, ApprovalRecord, RecentWorkRecord, SessionRecord, TakeoverSuccessCheck, TaskRecord } from "../domain.ts";
import { RecentWorkService } from "./recent-work-service.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import { nowIso } from "../utils/time.ts";
import { SummaryService } from "./summary-service.ts";
import { RuntimeDiscoveryService } from "./runtime-discovery-service.ts";
import { parseJsonSafe } from "../utils/json.ts";
import { UpdateService } from "./update-service.ts";

interface DashboardServiceOptions {
  storage: AsynqAgentdStorage;
  tasks: TaskService;
  sessions: SessionService;
  recentWork: RecentWorkService;
  summaries: SummaryService;
  runtimes: RuntimeDiscoveryService;
  updates: UpdateService;
}

type ObservedPendingReview = {
  action: string;
  context: string;
  cmd?: string;
  detected_at?: string;
};

type DashboardAttentionItem = {
  approval_id: string;
  session_id?: string;
  recent_work_id?: string;
  task_id?: string;
  title: string;
  action: string;
  context: string;
  agent_type?: string;
  project_path?: string;
  summary?: string;
  next_action?: string;
  created_at: string;
  can_resolve?: boolean;
  review?: {
    machine: string;
    agent: string;
    branch?: string;
    project: string;
    review_hint: string;
    test_status: string;
    stats: {
      files_changed: number;
      lines_added: number;
      lines_removed: number;
    };
    suggested_actions: string[];
    command?: string;
    read_only?: boolean;
    source_recent_work_id?: string;
    source_session_kind?: "managed" | "observed";
    empty_state?: string;
    takeover_supported?: boolean;
    takeover_reason?: string;
    show_stats?: boolean;
    files: Array<{
      path: string;
      action: "edited" | "created" | "deleted";
      lines_added?: number;
      lines_removed?: number;
      summary?: string;
      diff_preview?: string[];
    }>;
  };
  update?: {
    target: "agentd" | "buddy_app";
    current_version?: string;
    latest_version?: string;
    minimum_supported_version?: string;
    release_url?: string;
    app_store_url?: string;
    install_supported?: boolean;
    state?: "available" | "required" | "installing" | "restarting";
  };
};

export class DashboardService {
  private readonly storage: AsynqAgentdStorage;
  private readonly tasks: TaskService;
  private readonly sessions: SessionService;
  private readonly recentWork: RecentWorkService;
  private readonly summaries: SummaryService;
  private readonly runtimes: RuntimeDiscoveryService;
  private readonly updates: UpdateService;
  private lastRecentWorkRefreshAt = 0;

  constructor(options: DashboardServiceOptions) {
    this.storage = options.storage;
    this.tasks = options.tasks;
    this.sessions = options.sessions;
    this.recentWork = options.recentWork;
    this.summaries = options.summaries;
    this.runtimes = options.runtimes;
    this.updates = options.updates;
  }

  getOverview(client?: { app_version?: string; min_supported_agentd_version?: string }) {
    this.refreshRecentWork();
    const sessions = this.sessions.list();
    const tasks = this.tasks.list();
    const approvals = this.storage.listApprovals("pending");
    const observedApprovals = this.listObservedApprovals();
    const updateItems = this.buildUpdateAttentionItems(client);
    const activeSessions = sessions.filter((session) => session.state === "working" || session.state === "waiting_approval");
    const runtimes = this.runtimes.list().filter((runtime) => runtime.available && runtime.id !== "custom" && runtime.mode === "real");
    const continueCount = this.getContinueWorking().items.length;

    return {
      generated_at: nowIso(),
      counts: {
        sessions_active: activeSessions.length,
        sessions_working: sessions.filter((session) => session.state === "working").length,
        approvals_pending: approvals.length + observedApprovals.length + updateItems.length,
        tasks_running: tasks.filter((task) => task.status === "running").length,
        tasks_paused: tasks.filter((task) => task.status === "paused").length,
        runtimes_ready: runtimes.length,
        continue_working: continueCount,
      },
      runtimes,
      daemon: {
        version: this.updates.getStatus().current_version,
      },
      updates: this.updates.getStatus(),
      compatibility: this.updates.getCompatibility(client),
    };
  }

  getManagedSessions() {
    const sessions = this.sessions.list();
    const visibleSessions = sessions
      .filter((session) =>
        session.state === "working"
        || session.state === "waiting_approval"
        || session.state === "completed"
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 12);
    return {
      generated_at: nowIso(),
      items: visibleSessions.map((session) => this.toSessionCard(session)),
    };
  }

  getAttentionRequired(client?: { app_version?: string; min_supported_agentd_version?: string }) {
    this.refreshRecentWork();
    const approvals = this.storage.listApprovals("pending").map((approval) => this.toApprovalCard(approval));
    const observedApprovals = this.listObservedApprovals();
    const updateItems = this.buildUpdateAttentionItems(client);
    return {
      generated_at: nowIso(),
      items: [...updateItems, ...approvals, ...observedApprovals]
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    };
  }

  getApprovalDetail(id: string, client?: { app_version?: string; min_supported_agentd_version?: string }) {
    this.refreshRecentWork();
    const updateItem = this.buildUpdateAttentionItems(client).find((item) => item.approval_id === id);
    if (updateItem) {
      return updateItem;
    }

    const approval = this.storage.getApproval(id);
    if (approval) {
      return this.toApprovalCard(approval);
    }

    return this.findObservedApproval(id);
  }

  private buildUpdateAttentionItems(client?: { app_version?: string; min_supported_agentd_version?: string }): DashboardAttentionItem[] {
    const status = this.updates.getStatus();
    const compatibility = this.updates.getCompatibility(client);
    const createdAt = status.checked_at ?? nowIso();
    const items: DashboardAttentionItem[] = [];

    if (status.status === "update_available" && status.latest_version) {
      items.push({
        approval_id: "update:agentd",
        title: "Update asynq-agentd",
        action: `Install ${status.latest_version}`,
        context: status.release_notes ?? "A newer agentd release is available.",
        summary: `Update available: ${status.current_version} → ${status.latest_version}`,
        next_action: "install_update",
        created_at: createdAt,
        can_resolve: false,
        review: {
          machine: "Linked machine",
          agent: "custom",
          branch: "Version management",
          project: "asynq-agentd",
          review_hint: status.release_notes ?? "Install the latest agentd release and restart the daemon.",
          test_status: "The daemon will restart after installation.",
          stats: {
            files_changed: 0,
            lines_added: 0,
            lines_removed: 0,
          },
          suggested_actions: [],
          empty_state: "Release notes will appear here when available.",
          show_stats: false,
          source_session_kind: "managed",
        },
        update: {
          target: "agentd",
          current_version: status.current_version,
          latest_version: status.latest_version,
          release_url: status.release_url,
          install_supported: status.install_supported,
          state: status.status === "restarting" ? "restarting" : status.status === "installing" ? "installing" : "available",
        },
      });
    }

    if (compatibility.requires_buddy_update) {
      items.push({
        approval_id: "update:buddy",
        title: "Update Asynq Buddy",
        action: "Open App Store",
        context: `Buddy ${compatibility.app_version ?? "unknown"} is older than the minimum supported version ${compatibility.min_supported_buddy_version}.`,
        summary: "Your app is too old for this daemon build.",
        next_action: "open_app_store",
        created_at: nowIso(),
        can_resolve: false,
        review: {
          machine: "This phone",
          agent: "custom",
          branch: "App compatibility",
          project: "Asynq Buddy",
          review_hint: `Update Buddy to at least ${compatibility.min_supported_buddy_version} to keep using the latest daemon features.`,
          test_status: "App update required for compatibility.",
          stats: {
            files_changed: 0,
            lines_added: 0,
            lines_removed: 0,
          },
          suggested_actions: [],
          empty_state: "Open the App Store and install the latest Buddy build.",
          show_stats: false,
          source_session_kind: "managed",
        },
        update: {
          target: "buddy_app",
          current_version: compatibility.app_version,
          latest_version: undefined,
          minimum_supported_version: compatibility.min_supported_buddy_version,
          app_store_url: compatibility.app_store_url,
          install_supported: false,
          state: "required",
        },
      });
    }

    if (compatibility.requires_agentd_update) {
      items.push({
        approval_id: "update:agentd-compatibility",
        title: "Update asynq-agentd",
        action: "Install compatible daemon",
        context: `This Buddy build requires agentd ${compatibility.min_supported_agentd_version} or newer, but the paired daemon is ${compatibility.agentd_version}.`,
        summary: "Your daemon is older than this Buddy build supports.",
        next_action: "install_update",
        created_at: nowIso(),
        can_resolve: false,
        review: {
          machine: "Linked machine",
          agent: "custom",
          branch: "Daemon compatibility",
          project: "asynq-agentd",
          review_hint: `Update the daemon to ${compatibility.min_supported_agentd_version} or newer.`,
          test_status: "Daemon update required for compatibility.",
          stats: {
            files_changed: 0,
            lines_added: 0,
            lines_removed: 0,
          },
          suggested_actions: [],
          empty_state: "The current Buddy build needs a newer daemon version.",
          show_stats: false,
          source_session_kind: "managed",
        },
        update: {
          target: "agentd",
          current_version: compatibility.agentd_version,
          latest_version: status.latest_version,
          minimum_supported_version: compatibility.min_supported_agentd_version,
          release_url: status.release_url,
          install_supported: status.install_supported,
          state: "required",
        },
      });
    }

    return items;
  }

  getContinueWorking() {
    this.refreshRecentWork();
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
        summary: this.summaries.getSessionCardSummary(
          session,
          this.pickManagedSessionSummary(session.id, this.pickLatestAgentOutput(session.id)) ?? this.summarizeSession(session),
        ),
        next_action: session.state === "waiting_approval" ? "review_approval" : "open_session",
        updated_at: session.updated_at,
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
        const takeover = this.findLinkedManagedTakeover(record);
        return {
          kind: "recent_work" as const,
          recent_work_id: record.id,
          title: summarized.title,
          source_type: record.source_type,
          status: record.status,
          project_path: record.project_path,
          summary: summarized.summary,
          next_action: summarized.nextMove ?? "continue_recent_work",
          updated_at: record.updated_at,
          observed_approval_id: this.getObservedApprovalId(record),
          linked_managed_session_id: takeover?.session_id,
          linked_managed_session_title: takeover?.session_title,
          linked_managed_status: takeover?.status,
        };
      });

    return {
      generated_at: nowIso(),
      items: [...activeOrPaused, ...recentItems].slice(0, 12),
    };
  }

  getRecentWorkDetail(id: string) {
    this.refreshRecentWork(true);
    const record = this.storage.getRecentWork(id);
    if (!record) {
      return undefined;
    }

    const metadata = record.metadata ?? {};
    const observedApproval = this.buildObservedApproval(record);
    const rawAgentResponse = this.pickString(
      metadata.raw_agent_response,
      metadata.last_agent_message,
      metadata.last_assistant_message,
    );
    const rawUserInput = this.pickString(
      metadata.raw_user_input,
      metadata.last_user_message,
    );
    const fallbackTitle = this.summarizeRecentWorkTitle(record);
    const fallbackSummary = this.summarizeRecentWorkForContinue(record);
    const summarized = this.summaries.readContinueCard(record, fallbackTitle, fallbackSummary);
    const takeover = this.findLinkedManagedTakeover(record);

    return {
      id: record.id,
      title: summarized.title,
      project_path: record.project_path,
      project: this.projectName(record.project_path ?? "Linked project"),
      source_type: record.source_type,
      status: record.status,
      is_working: record.status === "active",
      summary: summarized.summary,
      raw_user_input: rawUserInput,
      raw_agent_response: rawAgentResponse,
      next_move: summarized.nextMove,
      changed_files: this.collectChangedFiles(record, rawAgentResponse),
      approval: observedApproval
        ? {
            approval_id: observedApproval.approval_id,
          }
        : undefined,
      takeover,
      updated_at: record.updated_at,
    };
  }

  private refreshRecentWork(force = false) {
    const now = Date.now();
    if (!force && now - this.lastRecentWorkRefreshAt < 2000) {
      return;
    }

    this.lastRecentWorkRefreshAt = now;
    this.recentWork.scan();
  }

  getManagedSessionDetail(id: string) {
    const session = this.sessions.getRecord(id);
    if (!session) {
      return undefined;
    }

    const task = session.task_id ? this.tasks.get(session.task_id) : undefined;
    const parentSessionId = this.pickString(task?.context?.parent_session_id);
    const parentSession = parentSessionId ? this.sessions.getRecord(parentSessionId) : undefined;
    const linkedRecentWorkId = task ? this.linkedRecentWorkId(task) : undefined;
    const linkedRecentWork = linkedRecentWorkId ? this.storage.getRecentWork(linkedRecentWorkId) : undefined;
    const linkedMetadata = linkedRecentWork?.metadata ?? {};
    const rawAgentResponse = this.pickLatestAgentOutput(session.id);
    const rawUserInput = this.pickString(
      this.pickOperatorInstruction(task, session),
      linkedMetadata.raw_user_input,
      linkedMetadata.last_user_message,
    );
    const continuation = this.findLinkedManagedContinuation(session.id);
    const summary = this.summaries.getSessionCardSummary(
      session,
      this.pickManagedSessionSummary(session.id, rawAgentResponse) ?? this.summarizeSession(session),
    );
    const sourceObserved = parentSession
      ? {
          recent_work_id: parentSession.id,
          title: parentSession.title,
          source_session_kind: "managed" as const,
        }
      : linkedRecentWork
        ? {
            recent_work_id: linkedRecentWork.id,
            title: this.summaries.readContinueCard(
              linkedRecentWork,
              this.summarizeRecentWorkTitle(linkedRecentWork),
              this.summarizeRecentWorkForContinue(linkedRecentWork),
            ).title,
            source_session_kind: "observed" as const,
          }
        : undefined;

    return {
      id: session.id,
      title: session.title,
      project_path: session.project_path,
      project: this.projectName(session.project_path),
      branch: session.branch,
      agent_type: session.agent_type,
      state: session.state,
      is_working: session.state === "working" || session.state === "waiting_approval",
      adapter: session.adapter,
      summary,
      raw_user_input: rawUserInput,
      raw_agent_response: rawAgentResponse,
      next_move: this.extractNextMove(rawAgentResponse ?? summary),
      changed_files: this.collectSessionChangedFiles(session.id).length > 0
        ? this.collectSessionChangedFiles(session.id)
        : linkedRecentWork
          ? this.collectChangedFiles(linkedRecentWork, rawAgentResponse)
          : [],
      live_progress: this.collectSessionLiveProgress(session.id),
      source_observed: sourceObserved,
      continuation,
      can_delete: this.tasks.canDeleteManagedSession(session.id),
      updated_at: session.updated_at,
    };
  }

  private toSessionCard(session: SessionRecord) {
    const task = session.task_id ? this.tasks.get(session.task_id) : undefined;
    const parentSessionId = this.pickString(task?.context?.parent_session_id);
    const parentSession = parentSessionId ? this.sessions.getRecord(parentSessionId) : undefined;
    const linkedRecentWorkId = task ? this.linkedRecentWorkId(task) : undefined;
    const linkedRecentWork = linkedRecentWorkId ? this.storage.getRecentWork(linkedRecentWorkId) : undefined;
    const sourceSessionKind = parentSession ? "managed" : linkedRecentWork ? "observed" : undefined;
    return {
      session_id: session.id,
      task_id: session.task_id,
      title: session.title,
      agent_type: session.agent_type,
      state: session.state,
      adapter: session.adapter,
      project_path: session.project_path,
      branch: session.branch,
      summary: this.summaries.getSessionCardSummary(
        session,
        this.pickManagedSessionSummary(session.id, this.pickLatestAgentOutput(session.id)) ?? this.summarizeSession(session),
      ),
      last_event: this.storage.listActivity({ session_id: session.id, limit: 1 })[0] ?? null,
      task_status: task?.status,
      terminal: {
        mode: this.pickString(session.metadata?.terminal_mode) ?? "pipe",
        transport: this.pickString(session.metadata?.terminal_transport) ?? "direct",
        size: session.metadata?.terminal_size ?? null,
      },
      source_observed_id: parentSession
        ? parentSession.id
        : linkedRecentWork?.id,
      source_observed_title: parentSession
        ? parentSession.title
        : linkedRecentWork
          ? this.summaries.readContinueCard(
            linkedRecentWork,
            this.summarizeRecentWorkTitle(linkedRecentWork),
            this.summarizeRecentWorkForContinue(linkedRecentWork),
          ).title
          : undefined,
      source_session_kind: sourceSessionKind,
      can_delete: this.tasks.canDeleteManagedSession(session.id),
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

  private listObservedApprovals() {
    return this.recentWork.list()
      .filter((record) => this.shouldIncludeRecentWork(record))
      .map((record) => this.buildObservedApproval(record))
      .filter((item): item is ReturnType<DashboardService["buildObservedApproval"]> extends infer T ? Exclude<T, undefined> : never => Boolean(item));
  }

  private findObservedApproval(id: string) {
    return this.listObservedApprovals().find((item) => item.approval_id === id);
  }

  private buildObservedApproval(record: RecentWorkRecord) {
    if (this.shouldSuppressObservedApproval(record)) {
      return undefined;
    }

    const pendingReview = this.pickObservedPendingReview(record);
    if (!pendingReview) {
      return undefined;
    }

    const agentType = record.source_type.includes("claude") ? "claude-code" : "codex";
    const commandSummary = pendingReview.cmd
      ? `Pending command: ${pendingReview.cmd}`
      : "Review the pending approval in the observed desktop session.";
    const takeoverSupport = this.assessObservedTakeoverSupport(record, pendingReview);
    const hasStructuredDiff = false;

    return {
      approval_id: this.getObservedApprovalId(record),
      recent_work_id: record.id,
      title: this.summaries.readContinueCard(
        record,
        this.summarizeRecentWorkTitle(record),
        this.summarizeRecentWorkForContinue(record),
      ).title,
      action: pendingReview.action,
      context: pendingReview.context,
      agent_type: agentType,
      project_path: record.project_path,
      summary: record.summary,
      next_action: "open_observed_review",
      created_at: record.updated_at,
      can_resolve: false,
      review: {
        machine: "Observed desktop session",
        agent: agentType,
        branch: "Observed thread",
        project: this.projectName(record.project_path ?? "Linked project"),
        review_hint: pendingReview.context,
        test_status: takeoverSupport.supported
          ? "This approval can be taken over into a managed session."
          : (takeoverSupport.reason ?? "Resolve this permission prompt in the active desktop session."),
        stats: {
          files_changed: 0,
          lines_added: 0,
          lines_removed: 0,
        },
        suggested_actions: [],
        command: pendingReview.cmd,
        files: [],
        read_only: true,
        source_recent_work_id: record.id,
        source_session_kind: "observed",
        empty_state: commandSummary,
        takeover_supported: takeoverSupport.supported,
        takeover_reason: takeoverSupport.reason,
        show_stats: hasStructuredDiff,
      },
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
      show_stats: fileEntries.length > 0 || linesAdded > 0 || linesRemoved > 0,
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

  private getObservedApprovalId(record: RecentWorkRecord): string | undefined {
    return this.pickObservedPendingReview(record) && !this.shouldSuppressObservedApproval(record)
      ? `observed-review:${record.id}`
      : undefined;
  }

  private shouldSuppressObservedApproval(record: RecentWorkRecord): boolean {
    const pendingReview = this.pickObservedPendingReview(record);
    if (!pendingReview) {
      return false;
    }

    const takeover = this.findLinkedManagedTakeover(record);
    if (!takeover || takeover.status === "failed") {
      return false;
    }

    const pendingDetectedAt = pendingReview.detected_at ?? record.updated_at;
    return takeover.updated_at >= pendingDetectedAt;
  }

  private pickObservedPendingReview(record: RecentWorkRecord): { action: string; context: string; cmd?: string; detected_at?: string } | undefined {
    const pending = record.metadata?.pending_observed_review;
    if (!pending || typeof pending !== "object") {
      return undefined;
    }

    const objectPending = pending as Record<string, unknown>;
    const action = this.pickString(objectPending.action);
    const context = this.pickString(objectPending.context);
    if (!action || !context) {
      return undefined;
    }

    return {
      action,
      context,
      cmd: this.pickString(objectPending.cmd),
      detected_at: this.pickString(objectPending.detected_at),
    };
  }

  private assessObservedTakeoverSupport(
    record: RecentWorkRecord,
    pendingReview: { cmd?: string },
  ): { supported: boolean; reason?: string } {
    const projectPath = this.pickString(record.project_path);
    const command = this.pickString(pendingReview.cmd);
    if (!projectPath || !command) {
      return {
        supported: false,
        reason: "This review can only be resolved in the active desktop session.",
      };
    }

    const successChecks = Array.isArray((record.metadata?.pending_observed_review as Record<string, unknown> | undefined)?.success_checks)
      ? ((record.metadata?.pending_observed_review as Record<string, unknown>).success_checks as unknown[])
          .map((item) => this.toTakeoverSuccessCheck(item))
          .filter((item): item is TakeoverSuccessCheck => Boolean(item))
      : [];

    const externalPathCheck = successChecks.find((check) =>
      check.kind === "path_exists"
      && this.pickString(check.path)
      && !this.isPathInsideProject(this.pickString(check.path)!, projectPath));
    if (externalPathCheck?.path) {
      return {
        supported: false,
        reason: `This command targets a path outside the managed workspace: ${externalPathCheck.path}`,
      };
    }

    return { supported: true };
  }

  private toTakeoverSuccessCheck(value: unknown): TakeoverSuccessCheck | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const objectValue = value as Record<string, unknown>;
    const kind = this.pickString(objectValue.kind);
    if (kind !== "path_exists" && kind !== "command_exit_zero") {
      return undefined;
    }

    return {
      kind,
      path: this.pickString(objectValue.path),
      path_type: this.pickString(objectValue.path_type) as TakeoverSuccessCheck["path_type"] | undefined,
      cmd: this.pickString(objectValue.cmd),
    };
  }

  private isPathInsideProject(candidatePath: string, projectPath: string): boolean {
    const normalizedProject = projectPath.replace(/[/\\]+$/, "");
    return candidatePath === normalizedProject || candidatePath.startsWith(`${normalizedProject}/`) || candidatePath.startsWith(`${normalizedProject}\\`);
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

    if (last.type === "agent_output") {
      return last.message;
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

  private findLinkedManagedTakeover(record: RecentWorkRecord) {
    const candidates = this.tasks
      .list()
      .filter((task) => this.linkedRecentWorkId(task) === record.id)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    const task = candidates[0];
    if (!task) {
      return undefined;
    }

    const session = task.assigned_session_id ? this.sessions.getRecord(task.assigned_session_id) : undefined;
    let status: "queued" | "starting" | "managed" | "waiting_approval" | "failed" | "completed";

    if (task.status === "failed") {
      status = "failed";
    } else if (task.status === "completed") {
      status = "completed";
    } else if (task.status === "queued") {
      status = "queued";
    } else if (task.status === "running" && session?.state === "working") {
      status = "managed";
    } else if (task.status === "running") {
      status = "starting";
    } else if (task.status === "paused" && session?.state === "waiting_approval") {
      status = "waiting_approval";
    } else if (task.status === "paused" && session) {
      status = "managed";
    } else {
      status = "queued";
    }

    const linkedTakeover = {
      task_id: task.id,
      status,
      session_id: session?.id,
      session_title: session?.title,
      updated_at: [task.updated_at, session?.updated_at]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? task.updated_at,
    };

    return linkedTakeover.updated_at >= record.updated_at ? linkedTakeover : undefined;
  }

  private findLinkedManagedContinuation(parentSessionId: string) {
    const candidates = this.tasks
      .list()
      .filter((task) => task.context?.parent_session_id === parentSessionId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    const task = candidates[0];
    if (!task) {
      return undefined;
    }

    const session = task.assigned_session_id ? this.sessions.getRecord(task.assigned_session_id) : undefined;
    let status: "queued" | "starting" | "managed" | "waiting_approval" | "failed" | "completed";

    if (task.status === "failed") {
      status = "failed";
    } else if (task.status === "completed") {
      status = "completed";
    } else if (task.status === "queued") {
      status = "queued";
    } else if (task.status === "running" && session?.state === "working") {
      status = "managed";
    } else if (task.status === "running") {
      status = "starting";
    } else if (task.status === "paused" && session?.state === "waiting_approval") {
      status = "waiting_approval";
    } else if (task.status === "paused" && session) {
      status = "managed";
    } else {
      status = "queued";
    }

    return {
      task_id: task.id,
      status,
      session_id: session?.id,
      session_title: session?.title,
    };
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
    return candidate.trim();
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

    if (this.isManagedRuntimeRecord(record) || this.isInternalRuntimeArtifact(record)) {
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
  private isManagedRuntimeRecord(record: RecentWorkRecord): boolean {
    if (
      record.source_type !== "codex-session-file"
      && record.source_type !== "codex-session-index"
      && record.source_type !== "claude-session"
      && record.source_type !== "claude-desktop-session"
    ) {
      return false;
    }

    return this.sessions.list().some((session) => {
      const metadata = session.metadata ?? {};
      return this.pickString(
        metadata.codex_session_id,
        metadata.codex_resume_session_id,
        metadata.claude_session_id,
        metadata.claude_resume_session_id,
      ) === record.id;
    });
  }

  private isInternalRuntimeArtifact(record: RecentWorkRecord): boolean {
    if (record.source_type !== "codex-session-file" && record.source_type !== "codex-session-index") {
      return false;
    }

    const metadata = record.metadata ?? {};
    const prompt = this.pickString(
      metadata.raw_user_input,
      metadata.last_user_message,
      record.title,
    ) ?? "";
    const normalized = prompt.trim();

    return normalized.startsWith("Task:")
      || normalized.startsWith("Rewrite recent work into compact mobile cards for Asynq Buddy.")
      || normalized.startsWith("Buddy managed handoff update for the observed thread.");
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

    if (/^<environment_context>/i.test(normalized)) {
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

  private pickLatestAgentOutput(sessionId: string): string | undefined {
    const events = this.storage.listActivity({ session_id: sessionId, limit: 25 });
    for (const event of events) {
      const payload = event.payload;
      if (payload.type === "agent_output" && this.pickString(payload.message)) {
        const message = payload.message.trim();
        if (!this.isLowSignalManagedRelayText(message)) {
          return message;
        }
      }
      if (payload.type === "agent_thinking" && this.pickString(payload.summary)) {
        const summary = payload.summary.trim();
        if (!this.isLowSignalManagedRelayText(summary)) {
          return summary;
        }
      }
      if (payload.type === "approval_requested" && this.pickString(payload.context)) {
        return payload.context.trim();
      }
      if ((payload.type === "file_batch" || payload.type === "file_batch_intent") && this.pickString(payload.summary)) {
        const summary = payload.summary.trim();
        if (!this.isLowSignalManagedRelayText(summary)) {
          return summary;
        }
      }
      if (payload.type === "error" && this.pickString(payload.message)) {
        return payload.message.trim();
      }
    }

    return this.pickLatestTerminalAgentOutput(sessionId);
  }

  private collectSessionLiveProgress(sessionId: string) {
    const items = this.storage.listActivity({ session_id: sessionId, limit: 12 });
    const mapped = items
      .map((event) => {
        const payload = event.payload;
        if (payload.type === "agent_output" && this.pickString(payload.message)) {
          const message = payload.message.trim();
          if (!this.isLowSignalManagedRelayText(message)) {
            return { id: String(event.id), summary: message, at: event.created_at };
          }
          return undefined;
        }
        if (payload.type === "agent_thinking" && this.pickString(payload.summary)) {
          const summary = payload.summary.trim();
          if (!this.isLowSignalManagedRelayText(summary)) {
            return { id: String(event.id), summary, at: event.created_at };
          }
          return undefined;
        }
        if ((payload.type === "file_batch" || payload.type === "file_batch_intent") && this.pickString(payload.summary)) {
          const summary = payload.summary.trim();
          if (!this.isLowSignalManagedRelayText(summary)) {
            return { id: String(event.id), summary, at: event.created_at };
          }
          return undefined;
        }
        if ((payload.type === "command_intent" || payload.type === "command_run") && this.pickString(payload.cmd)) {
          return { id: String(event.id), summary: `Command: ${payload.cmd.trim()}`, at: event.created_at };
        }
        if (payload.type === "approval_requested" && this.pickString(payload.context)) {
          return { id: String(event.id), summary: payload.context.trim(), at: event.created_at };
        }
        if (payload.type === "error" && this.pickString(payload.message)) {
          return { id: String(event.id), summary: payload.message.trim(), at: event.created_at };
        }
        return undefined;
      })
      .filter((item): item is { id: string; summary: string; at: string } => Boolean(item))
      .slice(0, 6);

    if (mapped.length > 0) {
      return mapped;
    }

    return this.collectTerminalLiveProgress(sessionId);
  }

  private linkedRecentWorkId(task: TaskRecord, visitedTaskIds = new Set<string>()): string | undefined {
    if (visitedTaskIds.has(task.id)) {
      return undefined;
    }

    visitedTaskIds.add(task.id);

    const direct = this.pickString(task.context?.source_recent_work_id);
    if (direct) {
      return direct;
    }

    const parentSessionId = this.pickString(task.context?.parent_session_id);
    if (parentSessionId) {
      const parentSession = this.sessions.getRecord(parentSessionId);
      const parentTask = parentSession?.task_id ? this.tasks.get(parentSession.task_id) : undefined;
      if (parentTask) {
        const inherited = this.linkedRecentWorkId(parentTask, visitedTaskIds);
        if (inherited) {
          return inherited;
        }
      }
    }

    return this.pickString(task.context?.previous_session_id);
  }

  private pickManagedSessionSummary(sessionId: string, rawAgentResponse?: string): string | undefined {
    const text = rawAgentResponse ?? this.collectSessionLiveProgress(sessionId)[0]?.summary;
    if (!text) {
      return undefined;
    }

    return this.deriveHeuristicSummary(text) ?? this.compactText(text, 240);
  }

  private extractNextMove(text: string | undefined): string | undefined {
    if (!text) {
      return undefined;
    }

    const patterns = [
      /další logick(?:ý|e) krok[:\s-]+(.+)/i,
      /další krok[:\s-]+(.+)/i,
      /next (?:logical )?step[:\s-]+(.+)/i,
      /next move[:\s-]+(.+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      const captured = match?.[1]?.trim();
      if (captured) {
        return this.compactText(captured, 160);
      }
    }

    return undefined;
  }

  private pickOperatorInstruction(task: TaskRecord | undefined, session: SessionRecord): string | undefined {
    const queuedMessages = Array.isArray(session.metadata?.queued_operator_messages)
      ? session.metadata?.queued_operator_messages as Array<Record<string, unknown>>
      : [];

    const latestQueued = queuedMessages
      .map((item) => this.pickString(item.message))
      .find(Boolean);

    if (latestQueued) {
      return latestQueued;
    }

    const observedTakeover = task?.context?.observed_takeover;
    if (observedTakeover && typeof observedTakeover === "object") {
      const pendingReview = this.pickObservedTakeoverContext(observedTakeover);
      if (pendingReview) {
        const sections = [
          "Observed takeover",
          `Requested action: ${pendingReview.action}`,
          `Context: ${pendingReview.context}`,
          pendingReview.cmd ? `Blocked command: ${pendingReview.cmd}` : undefined,
        ].filter((value): value is string => Boolean(value));
        return sections.join("\n\n");
      }
    }

    return this.sanitizeOperatorInstruction(this.pickString(task?.description));
  }

  private sanitizeOperatorInstruction(text: string | undefined): string | undefined {
    const value = this.pickString(text);
    if (!value) {
      return undefined;
    }

    const developerInstruction = value.match(/Developer instruction:\s*(.+)$/i)?.[1]?.trim();
    const withoutReasoning = value
      .replace(/\s*Last reasoning summary:\s*[^\n]+/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (developerInstruction) {
      return developerInstruction;
    }

    return withoutReasoning;
  }

  private isLowSignalManagedRelayText(text: string): boolean {
    return /^Relaying managed handoff back to observed Codex thread\b/i.test(text)
      || /^Managed handoff was appended to the observed Codex thread\.?$/i.test(text);
  }

  private pickObservedTakeoverContext(value: unknown): ObservedPendingReview | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const objectValue = value as Record<string, unknown>;
    const action = this.pickString(objectValue.action);
    const context = this.pickString(objectValue.context);
    if (!action || !context) {
      return undefined;
    }

    return {
      action,
      context,
      cmd: this.pickString(objectValue.cmd),
      detected_at: this.pickString(objectValue.detected_at),
    };
  }

  private collectSessionChangedFiles(sessionId: string): string[] {
    const files = new Set<string>();
    const events = this.storage.listActivity({ session_id: sessionId, limit: 50 });

    for (const event of events) {
      const payload = event.payload;
      if (payload.type === "file_batch" || payload.type === "file_batch_intent") {
        for (const file of payload.files) {
          if (this.pickString(file.path)) {
            files.add(file.path.trim());
          }
        }
      }
    }

    return Array.from(files);
  }

  private pickLatestTerminalAgentOutput(sessionId: string): string | undefined {
    const chunks = this.storage.listTerminalEvents(sessionId, 200);
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      const chunk = chunks[index];
      if (!chunk || chunk.stream !== "stdout") {
        continue;
      }

      for (const line of chunk.chunk.split("\n").reverse()) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        const entry = parseJsonSafe<Record<string, unknown> | undefined>(trimmed, undefined);
        if (!entry) {
          continue;
        }

        const item = typeof entry.item === "object" && entry.item ? entry.item as Record<string, unknown> : undefined;
        if (this.pickString(entry.type) === "item.completed" && this.pickString(item?.type) === "agent_message") {
          const message = this.pickString(item?.text);
          if (message) {
            return message.trim();
          }
        }
      }
    }

    return undefined;
  }

  private collectTerminalLiveProgress(sessionId: string) {
    const chunks = this.storage.listTerminalEvents(sessionId, 200);
    const items: Array<{ id: string; summary: string; at: string }> = [];

    for (const chunk of chunks) {
      if (chunk.stream !== "stdout") {
        continue;
      }

      for (const line of chunk.chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        const entry = parseJsonSafe<Record<string, unknown> | undefined>(trimmed, undefined);
        if (!entry) {
          continue;
        }

        const entryType = this.pickString(entry.type);
        const item = typeof entry.item === "object" && entry.item ? entry.item as Record<string, unknown> : undefined;
        const itemType = this.pickString(item?.type);

        if (entryType === "item.completed" && itemType === "agent_message") {
          const message = this.pickString(item?.text);
          if (message) {
            items.push({ id: `${chunk.id}:agent`, summary: message.trim(), at: chunk.created_at });
          }
        } else if (entryType === "item.started" && itemType === "command_execution") {
          const command = this.pickString(item?.command);
          if (command) {
            items.push({ id: `${chunk.id}:cmd-start`, summary: `Running command: ${command.trim()}`, at: chunk.created_at });
          }
        } else if (entryType === "item.completed" && itemType === "command_execution") {
          const command = this.pickString(item?.command);
          if (command) {
            items.push({ id: `${chunk.id}:cmd-done`, summary: `Command finished: ${command.trim()}`, at: chunk.created_at });
          }
        }
      }
    }

    return items
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 6);
  }

  private collectChangedFiles(record: RecentWorkRecord, rawAgentResponse?: string): string[] {
    const metadata = record.metadata ?? {};
    const files = new Set<string>();

    if (Array.isArray(metadata.changed_files)) {
      for (const value of metadata.changed_files) {
        if (typeof value === "string" && value.trim()) {
          files.add(value.trim());
        }
      }
    }

    if (rawAgentResponse) {
      for (const file of this.extractChangedFilesFromText(rawAgentResponse, record.project_path)) {
        files.add(file);
      }
    }

    return Array.from(files);
  }

  private extractChangedFilesFromText(text: string, projectPath?: string): string[] {
    const files = new Set<string>();
    const markdownLinkPattern = /\[[^\]]+\]\(([^)]+\.[A-Za-z0-9]+)\)/g;
    const absolutePathPattern = /\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+/g;
    const relativePathPattern = /(?:^|\n)\s*([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]+)(?=\s|$)/gm;

    const pushMatch = (candidate: string) => {
      const normalized = candidate.trim().replace(/[),.:;]+$/, "");
      if (!normalized) {
        return;
      }
      if (projectPath && normalized.startsWith(projectPath)) {
        files.add(normalized);
        return;
      }
      if (normalized.includes("/") && /\.[A-Za-z0-9]+$/.test(normalized)) {
        files.add(normalized);
      }
    };

    for (const match of text.matchAll(markdownLinkPattern)) {
      pushMatch(match[1] ?? "");
    }

    for (const match of text.matchAll(absolutePathPattern)) {
      pushMatch(match[0] ?? "");
    }

    for (const match of text.matchAll(relativePathPattern)) {
      pushMatch(match[1] ?? "");
    }

    return Array.from(files);
  }
}
