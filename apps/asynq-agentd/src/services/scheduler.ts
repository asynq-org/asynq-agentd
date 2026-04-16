import { existsSync, statSync } from "node:fs";
import type { AgentAdapter } from "../adapters/agent-adapter.ts";
import type { AsynqAgentdStorage } from "../db/storage.ts";
import type { ActivityRecord, ObservedTakeoverContext, TakeoverSuccessCheck, TaskRecord } from "../domain.ts";
import { nowIso } from "../utils/time.ts";
import { getNextRunAt, isTaskDue } from "../utils/schedule.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import { ConfigService } from "./config-service.ts";
import { ApprovalPolicyService } from "./approval-policy-service.ts";
import { ProcessMonitorService } from "./process-monitor-service.ts";
import { TerminalStreamService } from "./terminal-stream-service.ts";

const PRIORITY_SCORE: Record<TaskRecord["priority"], number> = {
  low: 1,
  normal: 2,
  high: 3,
  urgent: 4,
};

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

export class SchedulerService {
  private timer?: NodeJS.Timeout;
  private runningSessions = new Set<string>();
  private readonly storage: AsynqAgentdStorage;
  private readonly tasks: TaskService;
  private readonly sessions: SessionService;
  private readonly config: ConfigService;
  private readonly adapters: Map<TaskRecord["agent_type"], AgentAdapter>;
  private readonly approvalPolicy: ApprovalPolicyService;
  private readonly processMonitor: ProcessMonitorService;
  private readonly terminalStreams?: TerminalStreamService;

  constructor(
    storage: AsynqAgentdStorage,
    tasks: TaskService,
    sessions: SessionService,
    config: ConfigService,
    adapters: Map<TaskRecord["agent_type"], AgentAdapter>,
    approvalPolicy = new ApprovalPolicyService(),
    processMonitor = new ProcessMonitorService(),
    terminalStreams?: TerminalStreamService,
  ) {
    this.storage = storage;
    this.tasks = tasks;
    this.sessions = sessions;
    this.config = config;
    this.adapters = adapters;
    this.approvalPolicy = approvalPolicy;
    this.processMonitor = processMonitor;
    this.terminalStreams = terminalStreams;
  }

  start(intervalMs = 1000): void {
    if (this.timer) {
      return;
    }

    void this.recoverInFlightTasks();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    const currentConfig = this.config.get();
    const activeCount = this.sessions.list().filter((session) => session.state === "working").length;
    const capacity = Math.max(0, currentConfig.max_parallel_sessions - activeCount);

    const candidates = this.tasks
      .list()
      .filter((task) => task.status === "queued" || task.status === "paused")
      .filter((task) => task.status !== "queued" || this.dependenciesSatisfied(task))
      .filter((task) => task.status !== "queued" || isTaskDue(task.next_run_at))
      .sort((a, b) => PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority] || a.created_at.localeCompare(b.created_at));

    let remainingCapacity = capacity;

    for (const task of candidates) {
      if (task.status === "queued" && task.approval_required && !task.assigned_session_id) {
        this.stageApproval(task);
        continue;
      }

      if (task.status === "queued" && !task.assigned_session_id && this.stageObservedTakeoverApproval(task)) {
        continue;
      }

      if (task.status === "paused") {
        const session = task.assigned_session_id ? this.sessions.getRecord(task.assigned_session_id) : undefined;
        if (!session) {
          continue;
        }

        if (session.state === "waiting_approval") {
          continue;
        }

        if (session.state === "errored") {
          this.tasks.update(task.id, { status: "failed" });
          continue;
        }

        if (session.state === "working" && remainingCapacity > 0) {
          await this.runTask(task, session.id);
          remainingCapacity -= 1;
        }
        continue;
      }

      if (remainingCapacity === 0) {
        continue;
      }

      await this.runTask(task);
      remainingCapacity -= 1;
    }
  }

  async recoverInFlightTasks(): Promise<void> {
    const runningTasks = this.tasks
      .list()
      .filter((task) => task.status === "running" && task.assigned_session_id);

    for (const task of runningTasks) {
      if (!task.assigned_session_id || this.runningSessions.has(task.id)) {
        continue;
      }

      const session = this.sessions.getRecord(task.assigned_session_id);
      if (!session) {
        this.tasks.update(task.id, { status: "failed" });
        continue;
      }

      if (session.state !== "working") {
        continue;
      }

      const adapter = this.adapters.get(task.agent_type);
      if (!adapter) {
        this.tasks.update(task.id, { status: "failed" });
        this.sessions.transition(session.id, "errored");
        continue;
      }

      const existingPid = typeof session.metadata?.adapter_pid === "number"
        ? session.metadata.adapter_pid
        : undefined;
      if (this.processMonitor.isAlive(existingPid)) {
        this.sessions.mergeMetadata(session.id, {
          runtime_reconciled_at: nowIso(),
          runtime_process_alive: true,
        });
        continue;
      }

      if (adapter.canResumeTask && !adapter.canResumeTask(task, session)) {
        this.tasks.update(task.id, {
          status: "paused",
          assigned_session_id: session.id,
        });
        this.sessions.mergeMetadata(session.id, {
          runtime_reconciled_at: nowIso(),
          runtime_process_alive: false,
          recovery_required: "manual_relaunch_approval",
        });
        this.sessions.requestApproval(
          session.id,
          `Relaunch interrupted task "${task.title}"`,
          `The original ${task.agent_type} process for task ${task.id} is no longer running, and no resumable external session id was persisted. Approve a fresh relaunch only if duplicate work is acceptable.`,
        );
        continue;
      }

      this.sessions.mergeMetadata(session.id, {
        runtime_reconciled_at: nowIso(),
        runtime_process_alive: false,
        recovery_required: undefined,
      });

      await this.runTask(task, session.id);
    }
  }

  private dependenciesSatisfied(task: TaskRecord): boolean {
    return task.depends_on.every((id) => this.tasks.get(id)?.status === "completed");
  }

  private stageApproval(task: TaskRecord): void {
    const session = this.sessions.createFromTask(task, "approval-gate");
    this.tasks.update(task.id, {
      status: "paused",
      assigned_session_id: session.id,
    });
    this.sessions.requestApproval(
      session.id,
      `Start task "${task.title}"`,
      `Task ${task.id} requires approval before ${task.agent_type} work can begin in ${task.project_path}.`,
    );
  }

  private stageObservedTakeoverApproval(task: TaskRecord): boolean {
    const observedTakeover = task.context?.observed_takeover;
    const command = pickString(observedTakeover?.cmd);
    if (!observedTakeover || !command) {
      return false;
    }

    const decision = this.approvalPolicy.shouldRequireApproval(
      { type: "command_intent", cmd: command, source: "tool_call" },
      task,
      this.config.getEffective(task.project_path),
    );
    if (!decision) {
      return false;
    }

    const session = this.sessions.createFromTask(task, "approval-gate");
    this.tasks.update(task.id, {
      status: "paused",
      assigned_session_id: session.id,
    });
    this.sessions.requestApproval(
      session.id,
      decision.action,
      `${decision.context}\n\nObserved takeover command: ${command}`,
    );
    return true;
  }

  private async runTask(task: TaskRecord, existingSessionId?: string): Promise<void> {
    if (this.runningSessions.has(task.id)) {
      return;
    }

    const adapter = this.adapters.get(task.agent_type);
    if (!adapter) {
      this.tasks.update(task.id, { status: "failed" });
      return;
    }

    this.runningSessions.add(task.id);
    const session = existingSessionId
      ? this.sessions.update({
          ...(this.sessions.getRecord(existingSessionId) ?? this.sessions.createFromTask(task, adapter.name)),
          state: "working",
          adapter: adapter.name,
        })
      : this.sessions.createFromTask(task, adapter.name);

    this.tasks.update(task.id, {
      status: "running",
      assigned_session_id: session.id,
      updated_at: nowIso(),
    } as Partial<TaskRecord>);

    const hooks = {
      onEvent: (payload: Parameters<typeof this.sessions.recordEvent>[1]) => {
        this.sessions.recordEvent(session.id, payload);
        const decision = this.approvalPolicy.shouldRequireApproval(payload, task, this.config.getEffective(task.project_path));
        if (!decision) {
          return;
        }

        const currentSession = this.sessions.getRecord(session.id);
        if (currentSession?.state === "waiting_approval") {
          return;
        }

        this.tasks.update(task.id, {
          status: "paused",
          assigned_session_id: session.id,
        });
        this.sessions.requestApproval(session.id, decision.action, decision.context);
        adapter.stopSession?.(session.id);
      },
      onSessionPatch: (patch: Record<string, unknown>) => {
        this.sessions.mergeMetadata(session.id, patch);
      },
      onTerminalData: (stream: "stdout" | "stderr", chunk: string) => {
        this.terminalStreams?.publish(session.id, stream, chunk);
      },
    };

    this.sessions.registerControl(session.id, {
      sendMessage: (message: string) => {
        const current = this.sessions.getRecord(session.id);
        const queued = Array.isArray(current?.metadata?.queued_operator_messages)
          ? current?.metadata?.queued_operator_messages as unknown[]
          : [];
        this.sessions.mergeMetadata(session.id, {
          queued_operator_messages: [
            ...queued,
            {
              at: nowIso(),
              message,
            },
          ],
        });
        this.sessions.recordEvent(session.id, {
          type: "agent_thinking",
          summary: `Operator message queued for Codex resume: ${message}`,
        });
      },
      writeInput: (input: string) => {
        if (!adapter.writeTerminalInput) {
          throw new Error(`${adapter.name} does not support live terminal input`);
        }

        adapter.writeTerminalInput(session.id, input);
        this.terminalStreams?.publish(session.id, "stdin", input);
      },
      resize: (cols: number, rows: number) => {
        adapter.resizeTerminal?.(session.id, cols, rows);
      },
      stop: () => {
        adapter.stopSession?.(session.id);
      },
    });

    try {
      await adapter.runTask(task, session, hooks);
      const postRunSession = this.sessions.getRecord(session.id);
      const postRunTask = this.tasks.get(task.id);
      if (postRunSession?.state === "waiting_approval" || postRunTask?.status === "paused") {
        return;
      }

      const takeoverFailure = this.verifyObservedTakeover(task, session.id);
      if (takeoverFailure) {
        this.sessions.recordEvent(session.id, {
          type: "error",
          message: takeoverFailure,
          recoverable: true,
        });
        this.sessions.transition(session.id, "errored");
        this.tasks.update(task.id, {
          status: "failed",
          assigned_session_id: session.id,
          last_run_at: nowIso(),
        });
        await this.relayManagedHandoff(task.id, session.id, "failed");
        return;
      }

      this.sessions.transition(session.id, "completed");
      if (task.schedule) {
        this.tasks.update(task.id, {
          status: "queued",
          assigned_session_id: undefined,
          last_run_at: nowIso(),
          next_run_at: getNextRunAt(task.schedule),
          context: this.withRecurringRunHistory(task, session.id, "completed"),
        });
      } else {
        this.tasks.update(task.id, {
          status: "completed",
          assigned_session_id: session.id,
          last_run_at: nowIso(),
        });
      }
      await this.relayManagedHandoff(task.id, session.id, "completed");
    } catch (error) {
      this.sessions.recordEvent(session.id, {
        type: "error",
        message: error instanceof Error ? error.message : "Unknown adapter failure",
        recoverable: false,
      });
      this.sessions.transition(session.id, "errored");
      if (task.schedule) {
        this.tasks.update(task.id, {
          status: "queued",
          assigned_session_id: undefined,
          last_run_at: nowIso(),
          next_run_at: getNextRunAt(task.schedule),
          context: this.withRecurringRunHistory(task, session.id, "failed"),
        });
      } else {
        this.tasks.update(task.id, {
          status: "failed",
          assigned_session_id: session.id,
        });
      }
      await this.relayManagedHandoff(task.id, session.id, "failed");
    } finally {
      this.sessions.unregisterControl(session.id);
      this.runningSessions.delete(task.id);
    }
  }

  private withRecurringRunHistory(
    task: TaskRecord,
    sessionId: string,
    status: "completed" | "failed",
  ): TaskRecord["context"] {
    const previousHistory = Array.isArray(task.context?.recurring_history)
      ? task.context.recurring_history
      : [];
    const nextEntry = {
      run_at: nowIso(),
      status,
      session_id: sessionId,
      summary: this.summarizeRecurringRun(sessionId, status),
    };

    return {
      ...(task.context ?? {}),
      recurring_history: [...previousHistory, nextEntry].slice(-12),
    };
  }

  private summarizeRecurringRun(sessionId: string, status: "completed" | "failed"): string {
    const events = this.storage.listActivity({ session_id: sessionId, limit: 40 });
    const useful = events
      .map((event) => this.describeRecurringActivity(event.payload))
      .filter((value): value is string => Boolean(value));
    const summary = useful.slice(0, 5).join(" ");
    return this.compactText(summary || (status === "completed" ? "Completed without a detailed summary." : "Failed before producing a detailed summary."), 360);
  }

  private describeRecurringActivity(payload: ActivityRecord["payload"]): string | undefined {
    switch (payload.type) {
      case "agent_thinking":
        return this.compactText(payload.summary, 180);
      case "file_create":
        return `Created ${payload.path}.`;
      case "file_edit":
        return `Edited ${payload.path}.`;
      case "file_delete":
        return `Deleted ${payload.path}.`;
      case "file_batch":
      case "file_batch_intent":
        return this.compactText(payload.summary, 180);
      case "command_run":
        return `Ran ${payload.cmd} with exit ${payload.exit_code}.`;
      case "error":
        return `Error: ${this.compactText(payload.message, 160)}`;
      default:
        return undefined;
    }
  }

  private compactText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  private async relayManagedHandoff(
    taskId: string,
    sessionId: string,
    outcome: "completed" | "failed",
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    const session = this.sessions.getRecord(sessionId);
    const targetConversationId = pickString(
      task?.context?.source_codex_session_id,
      task?.agent_type === "codex" ? task?.context?.source_recent_work_id : undefined,
    ) ?? "";
    if (!task || !session || !targetConversationId) {
      return;
    }

    if (typeof session.metadata?.managed_handoff_relayed_at === "string") {
      return;
    }

    const codexAdapter = this.adapters.get("codex");
    if (!codexAdapter?.appendToConversation) {
      return;
    }

    const prompt = this.buildManagedHandoffPrompt(task, session, outcome);
    this.sessions.recordEvent(sessionId, {
      type: "agent_thinking",
      summary: `Relaying managed handoff back to observed Codex thread ${targetConversationId}.`,
    });

    try {
      await codexAdapter.appendToConversation(targetConversationId, prompt, {
        projectPath: task.project_path,
        modelPreference: task.model_preference,
      });
      this.sessions.mergeMetadata(sessionId, {
        managed_handoff_relayed_at: nowIso(),
        managed_handoff_target_session_id: targetConversationId,
        managed_handoff_outcome: outcome,
        managed_handoff_relay_error: undefined,
      });
      this.sessions.recordEvent(sessionId, {
        type: "agent_thinking",
        summary: "Managed handoff was appended to the observed Codex thread.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Managed handoff relay failed";
      this.sessions.mergeMetadata(sessionId, {
        managed_handoff_relay_error: message,
        managed_handoff_target_session_id: targetConversationId,
      });
      this.sessions.recordEvent(sessionId, {
        type: "error",
        message: `Managed handoff relay failed: ${message}`,
        recoverable: true,
      });
    }
  }

  private buildManagedHandoffPrompt(
    task: TaskRecord,
    session: SessionRecord,
    outcome: "completed" | "failed",
  ): string {
    const summary = this.pickManagedHandoffSummary(session.id, outcome);
    const changedFiles = this.collectManagedChangedFiles(session.id).slice(0, 6);
    const changedFilesBlock = changedFiles.length > 0
      ? `Changed files:\n${changedFiles.map((file) => `- ${file}`).join("\n")}`
      : "Changed files:\n- None captured";

    return [
      "Buddy managed handoff update for the observed thread.",
      "",
      "Do not continue the prior task.",
      "Do not inspect files.",
      "Do not run commands.",
      "Do not change code.",
      "",
      "Append a short status update for future context using only the information below.",
      "",
      `Managed session title: ${session.title}`,
      `Status: ${outcome}`,
      `Summary: ${summary}`,
      changedFilesBlock,
      "",
      "Keep it under 120 words.",
    ].join("\n");
  }

  private pickManagedHandoffSummary(sessionId: string, outcome: "completed" | "failed"): string {
    const events = this.storage.listActivity({ session_id: sessionId, limit: 30 });
    for (const event of events) {
      const payload = event.payload;
      if (payload.type === "agent_output" && payload.message.trim()) {
        return payload.message.trim();
      }
      if (payload.type === "agent_thinking" && payload.summary.trim()) {
        return payload.summary.trim();
      }
      if ((payload.type === "file_batch" || payload.type === "file_batch_intent") && payload.summary.trim()) {
        return payload.summary.trim();
      }
      if (payload.type === "error" && payload.message.trim()) {
        return payload.message.trim();
      }
    }

    return outcome === "completed"
      ? `Managed session "${sessionId}" completed.`
      : `Managed session "${sessionId}" failed.`;
  }

  private collectManagedChangedFiles(sessionId: string): string[] {
    const files = new Set<string>();
    const events = this.storage.listActivity({ session_id: sessionId, limit: 50 });

    for (const event of events) {
      const payload = event.payload;
      if (payload.type === "file_edit" || payload.type === "file_create" || payload.type === "file_delete") {
        files.add(payload.path);
        continue;
      }

      if (payload.type === "file_batch" || payload.type === "file_batch_intent") {
        for (const file of payload.files) {
          files.add(file.path);
        }
      }
    }

    return Array.from(files);
  }

  private verifyObservedTakeover(task: TaskRecord, sessionId: string): string | undefined {
    const observedTakeover = task.context?.observed_takeover;
    if (!observedTakeover) {
      return undefined;
    }

    const checks = observedTakeover.success_checks ?? [];
    if (checks.length === 0) {
      return undefined;
    }

    const events = this.storage.listActivity({ session_id: sessionId, limit: 200 });
    for (const check of checks) {
      const failure = this.evaluateSuccessCheck(check, events, observedTakeover);
      if (failure) {
        return failure;
      }
    }

    return undefined;
  }

  private evaluateSuccessCheck(
    check: TakeoverSuccessCheck,
    events: ActivityRecord[],
    observedTakeover: ObservedTakeoverContext,
  ): string | undefined {
    if (check.kind === "command_exit_zero") {
      const expected = pickString(check.cmd, observedTakeover.cmd);
      if (!expected) {
        return undefined;
      }

      const matched = events.some((event) =>
        event.payload.type === "command_run"
        && event.payload.cmd.trim() === expected.trim()
        && event.payload.exit_code === 0);
      return matched
        ? undefined
        : `Observed takeover verification failed: expected command did not finish successfully: ${expected}`;
    }

    if (check.kind === "path_exists") {
      const targetPath = pickString(check.path);
      if (!targetPath) {
        return undefined;
      }

      if (!existsSync(targetPath)) {
        return `Observed takeover verification failed: expected path is still missing: ${targetPath}`;
      }

      if (check.path_type && check.path_type !== "any") {
        const stats = statSync(targetPath);
        if (check.path_type === "file" && !stats.isFile()) {
          return `Observed takeover verification failed: expected file at ${targetPath}`;
        }

        if (check.path_type === "directory" && !stats.isDirectory()) {
          return `Observed takeover verification failed: expected directory at ${targetPath}`;
        }
      }
    }

    return undefined;
  }
}
