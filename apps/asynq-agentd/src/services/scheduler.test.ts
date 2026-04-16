import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsynqAgentdStorage } from "../db/storage.ts";
import { TaskService } from "./task-service.ts";
import { SessionService } from "./session-service.ts";
import { ConfigService } from "./config-service.ts";
import { SchedulerService } from "./scheduler.ts";
import { MockAgentAdapter } from "../adapters/mock-adapter.ts";
import type { AgentAdapter, AdapterHooks } from "../adapters/agent-adapter.ts";
import type { SessionRecord, TaskRecord } from "../domain.ts";
import { ProcessMonitorService } from "./process-monitor-service.ts";

class RecoveryAdapter implements AgentAdapter {
  readonly name = "recovery";
  runs: string[] = [];
  resumable = true;

  async runTask(task: TaskRecord, session: SessionRecord, hooks: AdapterHooks): Promise<void> {
    this.runs.push(`${task.id}:${session.id}`);
    hooks.onSessionPatch({
      recovered: true,
    });
    hooks.onEvent({
      type: "agent_thinking",
      summary: "Recovered running task",
    });
  }

  canResumeTask(): boolean {
    return this.resumable;
  }
}

class InterceptedApprovalAdapter implements AgentAdapter {
  readonly name = "intercepted-approval";
  stopCalls = 0;

  async runTask(_task: TaskRecord, session: SessionRecord, hooks: AdapterHooks): Promise<void> {
    hooks.onSessionPatch({
      probe_session_id: session.id,
    });
    hooks.onEvent({
      type: "command_intent",
      cmd: "git push origin main",
      source: "tool_call",
    });
  }

  stopSession(): void {
    this.stopCalls += 1;
  }
}

class FailingAdapter implements AgentAdapter {
  readonly name = "failing";

  async runTask(_task: TaskRecord, _session: SessionRecord, hooks: AdapterHooks): Promise<void> {
    hooks.onEvent({
      type: "agent_thinking",
      summary: "Started recurring work before failing",
    });
    throw new Error("Synthetic recurring failure");
  }
}

class RelayRecordingCodexAdapter extends MockAgentAdapter {
  relays: Array<{
    conversationId: string;
    prompt: string;
    projectPath?: string;
    modelPreference?: string;
  }> = [];

  override async appendToConversation(
    conversationId: string,
    prompt: string,
    options?: {
      projectPath?: string;
      modelPreference?: string;
    },
  ): Promise<void> {
    this.relays.push({
      conversationId,
      prompt,
      projectPath: options?.projectPath,
      modelPreference: options?.modelPreference,
    });
  }
}

class ObservedTakeoverApprovalAdapter implements AgentAdapter {
  readonly name = "observed-takeover-approval";
  runs = 0;

  async runTask(): Promise<void> {
    this.runs += 1;
  }
}

class ObservedTakeoverVerificationAdapter implements AgentAdapter {
  readonly name = "observed-takeover-verification";
  private readonly command: string;
  private readonly outputPath?: string;

  constructor(command: string, outputPath?: string) {
    this.command = command;
    this.outputPath = outputPath;
  }

  async runTask(_task: TaskRecord, _session: SessionRecord, hooks: AdapterHooks): Promise<void> {
    hooks.onEvent({
      type: "command_run",
      cmd: this.command,
      exit_code: 0,
      duration_ms: 10,
      stdout_preview: "managed takeover command completed",
    });

    if (this.outputPath) {
      writeFileSync(this.outputPath, "backup");
    }
  }
}

class StaticProcessMonitor extends ProcessMonitorService {
  private readonly alive: boolean;

  constructor(alive: boolean) {
    super();
    this.alive = alive;
  }

  override isAlive(): boolean {
    return this.alive;
  }
}

test("scheduler runs queued tasks and completes them", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["custom", new MockAgentAdapter()],
      ["claude-code", new MockAgentAdapter()],
      ["codex", new MockAgentAdapter()],
      ["opencode", new MockAgentAdapter()],
    ]),
    undefined,
    new StaticProcessMonitor(false),
  );

  const task = tasks.create({
    title: "Run bootstrap task",
    description: "Exercise queue lifecycle",
    project_path: "/tmp/project",
  });

  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 140));

  assert.equal(tasks.get(task.id)?.status, "completed");
  assert.equal(sessions.list()[0]?.state, "completed");
  assert.ok(storage.listActivity({ session_id: sessions.list()[0]?.id }).length > 0);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("scheduler stages approvals before running approval-required tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["custom", new MockAgentAdapter()],
      ["claude-code", new MockAgentAdapter()],
      ["codex", new MockAgentAdapter()],
      ["opencode", new MockAgentAdapter()],
    ]),
  );

  const task = tasks.create({
    title: "Guard dangerous action",
    description: "Require approval before starting work",
    project_path: "/tmp/project",
    approval_required: true,
  });

  await scheduler.tick();

  const pausedTask = tasks.get(task.id);
  assert.equal(pausedTask?.status, "paused");
  assert.equal(storage.listApprovals("pending").length, 1);
  const approval = storage.listApprovals("pending")[0];
  assert.equal(sessions.getRecord(pausedTask?.assigned_session_id ?? "")?.state, "waiting_approval");

  sessions.resolveApproval(approval.id, "approved", "Proceed");
  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 140));

  assert.equal(tasks.get(task.id)?.status, "completed");
  assert.equal(sessions.getRecord(pausedTask?.assigned_session_id ?? "")?.state, "completed");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("scheduler stages Buddy approval before running a protected observed takeover command", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const adapter = new ObservedTakeoverApprovalAdapter();
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["codex", adapter],
    ]),
  );

  const task = tasks.create({
    title: "Take over observed backup",
    description: "Replay a blocked observed backup command.",
    project_path: "/tmp/project",
    agent_type: "codex",
    context: {
      observed_takeover: {
        action: "Approve command: cp ~/.asynq-agentd/asynq-agentd.sqlite ~/.asynq-agentd/asynq-agentd.sqlite.backup-test",
        context: "Do you want me to back up your agentd SQLite database?",
        cmd: "cp ~/.asynq-agentd/asynq-agentd.sqlite ~/.asynq-agentd/asynq-agentd.sqlite.backup-test",
      },
    },
  });

  await scheduler.tick();

  const pausedTask = tasks.get(task.id);
  assert.equal(pausedTask?.status, "paused");
  assert.equal(adapter.runs, 0);
  assert.equal(storage.listApprovals("pending").length, 1);
  assert.match(storage.listApprovals("pending")[0]?.context ?? "", /Observed takeover command/);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("scheduler reschedules recurring tasks after a successful run", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["custom", new MockAgentAdapter()],
      ["claude-code", new MockAgentAdapter()],
      ["codex", new MockAgentAdapter()],
      ["opencode", new MockAgentAdapter()],
    ]),
  );

  const task = tasks.create({
    title: "Nightly regression",
    description: "Recurring task should requeue itself",
    project_path: "/tmp/project",
    schedule: "0 2 * * *",
  });

  tasks.update(task.id, {
    next_run_at: new Date(Date.now() - 60_000).toISOString(),
  });

  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 140));

  const rescheduled = tasks.get(task.id);
  assert.equal(rescheduled?.status, "queued");
  assert.ok(rescheduled?.last_run_at);
  assert.ok(rescheduled?.next_run_at);
  assert.ok(new Date(rescheduled.next_run_at ?? 0).getTime() > Date.now());
  assert.equal(rescheduled?.context?.recurring_history?.length, 1);
  assert.equal(rescheduled?.context?.recurring_history?.[0]?.status, "completed");
  assert.match(rescheduled?.context?.recurring_history?.[0]?.summary ?? "", /Preparing task/);
  assert.match(rescheduled?.context?.recurring_history?.[0]?.summary ?? "", /README\.md/);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("scheduler records failure history and keeps recurring tasks scheduled", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["custom", new FailingAdapter()],
      ["claude-code", new MockAgentAdapter()],
      ["codex", new MockAgentAdapter()],
      ["opencode", new MockAgentAdapter()],
    ]),
  );

  const task = tasks.create({
    title: "Weekly blog draft",
    description: "Create a blog draft.",
    project_path: "/tmp/project",
    schedule: "0 8 * * 3",
  });

  tasks.update(task.id, {
    next_run_at: new Date(Date.now() - 60_000).toISOString(),
  });

  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const rescheduled = tasks.get(task.id);
  assert.equal(rescheduled?.status, "queued");
  assert.equal(rescheduled?.assigned_session_id, undefined);
  assert.ok(rescheduled?.next_run_at);
  assert.equal(rescheduled?.context?.recurring_history?.length, 1);
  assert.equal(rescheduled?.context?.recurring_history?.[0]?.status, "failed");
  assert.match(rescheduled?.context?.recurring_history?.[0]?.summary ?? "", /Synthetic recurring failure/);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("scheduler fails observed takeover completion when success checks are not satisfied", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const missingPath = join(root, "missing-backup.sqlite");
  const command = `cp /tmp/source.sqlite ${missingPath}`;
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["codex", new ObservedTakeoverVerificationAdapter(command)],
    ]),
  );

  const task = tasks.create({
    title: "Verify observed takeover backup",
    description: "Re-run the blocked backup command.",
    project_path: root,
    agent_type: "codex",
    context: {
      observed_takeover: {
        action: `Approve command: ${command}`,
        context: "Do the backup and verify it exists.",
        cmd: command,
        success_checks: [
          { kind: "command_exit_zero", cmd: command },
          { kind: "path_exists", path: missingPath, path_type: "file" },
        ],
      },
    },
  });

  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(tasks.get(task.id)?.status, "failed");
  const session = sessions.list()[0];
  assert.equal(session?.state, "errored");
  const errors = storage.listActivity({ session_id: session?.id, limit: 20 }).filter((event) => event.payload.type === "error");
  assert.match((errors[0]?.payload.type === "error" ? errors[0].payload.message : ""), /expected path is still missing/i);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("scheduler recovers in-flight running tasks after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const recoveryAdapter = new RecoveryAdapter();
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["custom", new MockAgentAdapter()],
      ["claude-code", new MockAgentAdapter()],
      ["codex", recoveryAdapter],
      ["opencode", new MockAgentAdapter()],
    ]),
  );

  const task = tasks.create({
    title: "Resume daemon-owned Codex task",
    description: "Should recover after daemon restart",
    project_path: "/tmp/project",
    agent_type: "codex",
  });
  const session = sessions.createFromTask(task, "codex-cli");
  tasks.update(task.id, {
    status: "running",
    assigned_session_id: session.id,
  });
  sessions.mergeMetadata(session.id, {
    codex_session_id: "019cda49-9e87-7a13-a4e8-7dddb62a9d99",
  });

  await scheduler.recoverInFlightTasks();

  assert.equal(recoveryAdapter.runs.length, 1);
  assert.equal(tasks.get(task.id)?.status, "completed");
  assert.equal(sessions.getRecord(session.id)?.state, "completed");
  assert.equal(sessions.getRecord(session.id)?.metadata?.recovered, true);
  assert.equal(sessions.getRecord(session.id)?.metadata?.runtime_process_alive, false);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("scheduler does not duplicate a running task if the persisted process is still alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const recoveryAdapter = new RecoveryAdapter();
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["custom", new MockAgentAdapter()],
      ["claude-code", new MockAgentAdapter()],
      ["codex", recoveryAdapter],
      ["opencode", new MockAgentAdapter()],
    ]),
    undefined,
    new StaticProcessMonitor(true),
  );

  const task = tasks.create({
    title: "Keep existing Codex process",
    description: "Should not spawn a duplicate if the old PID still exists.",
    project_path: "/tmp/project",
    agent_type: "codex",
  });
  const session = sessions.createFromTask(task, "codex-cli");
  tasks.update(task.id, {
    status: "running",
    assigned_session_id: session.id,
  });
  sessions.mergeMetadata(session.id, {
    adapter_pid: 4242,
    codex_session_id: "019cda49-9e87-7a13-a4e8-7dddb62a9d99",
  });

  await scheduler.recoverInFlightTasks();

  assert.equal(recoveryAdapter.runs.length, 0);
  assert.equal(tasks.get(task.id)?.status, "running");
  assert.equal(sessions.getRecord(session.id)?.state, "working");
  assert.equal(sessions.getRecord(session.id)?.metadata?.runtime_process_alive, true);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("scheduler relays managed Codex completion back to the source observed conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const codexAdapter = new RelayRecordingCodexAdapter();
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["custom", new MockAgentAdapter()],
      ["claude-code", new MockAgentAdapter()],
      ["codex", codexAdapter],
      ["opencode", new MockAgentAdapter()],
    ]),
  );

  const task = tasks.create({
    title: "Relay managed completion",
    description: "Finish work and append a Buddy handoff note.",
    project_path: "/tmp/project",
    agent_type: "codex",
    model_preference: "gpt-5.4",
    context: {
      source_recent_work_id: "codex-session-1",
      source_codex_session_id: "codex-session-1",
    },
  });

  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 140));

  assert.equal(tasks.get(task.id)?.status, "completed");
  assert.equal(codexAdapter.relays.length, 1);
  assert.equal(codexAdapter.relays[0]?.conversationId, "codex-session-1");
  assert.equal(codexAdapter.relays[0]?.projectPath, "/tmp/project");
  assert.equal(codexAdapter.relays[0]?.modelPreference, "gpt-5.4");
  assert.match(codexAdapter.relays[0]?.prompt ?? "", /Buddy managed handoff update/);
  assert.match(codexAdapter.relays[0]?.prompt ?? "", /Status: completed/);
  assert.match(codexAdapter.relays[0]?.prompt ?? "", /Changed files:/);

  const session = sessions.list()[0];
  assert.equal(typeof session?.metadata?.managed_handoff_relayed_at, "string");
  assert.equal(session?.metadata?.managed_handoff_target_session_id, "codex-session-1");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("scheduler relays managed Codex completion for legacy tasks using source recent-work id", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const codexAdapter = new RelayRecordingCodexAdapter();
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["custom", new MockAgentAdapter()],
      ["claude-code", new MockAgentAdapter()],
      ["codex", codexAdapter],
      ["opencode", new MockAgentAdapter()],
    ]),
  );

  const task = tasks.create({
    title: "Relay managed completion for legacy task",
    description: "Finish work and append a Buddy handoff note using the observed recent-work id.",
    project_path: "/tmp/project",
    agent_type: "codex",
    context: {
      source_recent_work_id: "codex-session-1",
    },
  });

  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 140));

  assert.equal(tasks.get(task.id)?.status, "completed");
  assert.equal(codexAdapter.relays.length, 1);
  assert.equal(codexAdapter.relays[0]?.conversationId, "codex-session-1");

  const session = sessions.list()[0];
  assert.equal(typeof session?.metadata?.managed_handoff_relayed_at, "string");
  assert.equal(session?.metadata?.managed_handoff_target_session_id, "codex-session-1");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("scheduler pauses restart recovery when resumable session metadata is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const recoveryAdapter = new RecoveryAdapter();
  recoveryAdapter.resumable = false;
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["custom", new MockAgentAdapter()],
      ["claude-code", new MockAgentAdapter()],
      ["codex", recoveryAdapter],
      ["opencode", new MockAgentAdapter()],
    ]),
    undefined,
    new StaticProcessMonitor(false),
  );

  const task = tasks.create({
    title: "Guard relaunch after lost process",
    description: "Recovery should not auto-relaunch without resumable metadata.",
    project_path: "/tmp/project",
    agent_type: "codex",
  });
  const session = sessions.createFromTask(task, "codex-cli");
  tasks.update(task.id, {
    status: "running",
    assigned_session_id: session.id,
  });

  await scheduler.recoverInFlightTasks();

  assert.equal(recoveryAdapter.runs.length, 0);
  assert.equal(tasks.get(task.id)?.status, "paused");
  assert.equal(sessions.getRecord(session.id)?.state, "waiting_approval");
  assert.equal(sessions.getRecord(session.id)?.metadata?.recovery_required, "manual_relaunch_approval");
  assert.equal(storage.listApprovals("pending").length, 1);
  assert.match(storage.listApprovals("pending")[0]?.action ?? "", /Relaunch interrupted task/);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("scheduler intercepts runtime actions that require approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-scheduler-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const config = new ConfigService(storage);
  const adapter = new InterceptedApprovalAdapter();
  const scheduler = new SchedulerService(
    storage,
    tasks,
    sessions,
    config,
    new Map([
      ["custom", adapter],
      ["claude-code", new MockAgentAdapter()],
      ["codex", new MockAgentAdapter()],
      ["opencode", new MockAgentAdapter()],
    ]),
  );

  const task = tasks.create({
    title: "Ship deployment changes",
    description: "This task should be paused when it tries to push.",
    project_path: "/tmp/project",
    agent_type: "custom",
  });

  await scheduler.tick();

  const updatedTask = tasks.get(task.id);
  assert.equal(updatedTask?.status, "paused");
  assert.equal(adapter.stopCalls, 1);
  assert.equal(storage.listApprovals("pending").length, 1);
  assert.match(storage.listApprovals("pending")[0]?.action ?? "", /Approve upcoming command/i);
  const session = sessions.getRecord(updatedTask?.assigned_session_id ?? "");
  assert.equal(session?.state, "waiting_approval");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});
