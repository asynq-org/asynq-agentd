import type { AgentAdapter } from "../adapters/agent-adapter.ts";
import type { AsynqAgentdStorage } from "../db/storage.ts";
import type { TaskRecord } from "../domain.ts";
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

      this.sessions.transition(session.id, "completed");
      if (task.schedule) {
        this.tasks.update(task.id, {
          status: "queued",
          assigned_session_id: undefined,
          last_run_at: nowIso(),
          next_run_at: getNextRunAt(task.schedule),
        });
      } else {
        this.tasks.update(task.id, {
          status: "completed",
          assigned_session_id: session.id,
          last_run_at: nowIso(),
        });
      }
    } catch (error) {
      this.sessions.recordEvent(session.id, {
        type: "error",
        message: error instanceof Error ? error.message : "Unknown adapter failure",
        recoverable: false,
      });
      this.sessions.transition(session.id, "errored");
      this.tasks.update(task.id, {
        status: "failed",
        assigned_session_id: session.id,
      });
    } finally {
      this.sessions.unregisterControl(session.id);
      this.runningSessions.delete(task.id);
    }
  }
}
