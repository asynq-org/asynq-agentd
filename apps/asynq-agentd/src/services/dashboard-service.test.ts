import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsynqAgentdStorage } from "../db/storage.ts";
import { TaskService } from "./task-service.ts";
import { SessionService } from "./session-service.ts";
import { RecentWorkService } from "./recent-work-service.ts";
import { DashboardService } from "./dashboard-service.ts";
import { SummaryService } from "./summary-service.ts";
import { RuntimeDiscoveryService } from "./runtime-discovery-service.ts";
import { UpdateService } from "./update-service.ts";
import { createDefaultConfig } from "../config.ts";

function createTestUpdates() {
  return new UpdateService({
    fetchImpl: async () => new Response(JSON.stringify({
      tag_name: "v0.4.0",
      html_url: "https://example.com/releases/v0.4.0",
      body: "Current release",
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
  });
}

test("dashboard service returns overview, attention cards, and continue items", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
    providers: [{
      id: "claude",
      isAvailable: () => true,
      summarize: async ({ prompt }) => prompt.includes("\"source_type\"")
        ? {
          title: "Resume payment refactor",
          summary: "Continue the payments API work without touching tests.",
        }
        : {
          summary: "Waiting for approval on the payment refactor.",
        },
    }],
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  const task = tasks.create({
    title: "Refactor API layer",
    description: "Continue the running backend refactor.",
    project_path: "/tmp/demo",
    agent_type: "claude-code",
  });
  const session = sessions.createFromTask(task, "claude-cli");
  sessions.mergeMetadata(session.id, {
    terminal_mode: "pipe",
    terminal_transport: "direct",
  });
  tasks.update(task.id, {
    status: "running",
    assigned_session_id: session.id,
  });
  sessions.recordEvent(session.id, {
    type: "file_batch_intent",
    summary: "Update payment handlers and validation files.",
    files: [
      {
        path: "/tmp/demo/services/payments/router.ts",
        action: "edited",
        lines_added: 12,
        lines_removed: 3,
      },
      {
        path: "/tmp/demo/services/payments/validate.ts",
        action: "edited",
        lines_added: 20,
        lines_removed: 8,
      },
    ],
  });
  sessions.recordEvent(session.id, {
    type: "agent_thinking",
    summary: "Refactoring the payment service boundaries.",
  });
  sessions.requestApproval(session.id, "Approve payment changes", "Modify 12 files in /services/payments");

  storage.upsertRecentWork({
    id: "recent_1",
    source_path: "/tmp/recent.jsonl",
    project_path: "/tmp/demo",
    title: "Recent Claude work",
    summary: "Continue the refactor with tests untouched.",
    source_type: "claude-session",
    status: "ended",
    updated_at: new Date().toISOString(),
    metadata: {},
  });

  const overview = dashboard.getOverview();
  assert.equal(overview.counts.approvals_pending, 1);
  assert.ok(typeof overview.counts.runtimes_ready === "number");
  assert.equal(overview.counts.sessions_active, 1);
  assert.equal(overview.counts.continue_working, 2);

  const managedSessions = dashboard.getManagedSessions();
  assert.equal(managedSessions.items.length, 1);
  assert.match(managedSessions.items[0]?.summary ?? "", /Modify 12 files/i);

  const attention = dashboard.getAttentionRequired();
  assert.equal(attention.items.length, 1);
  assert.equal(attention.items[0]?.next_action, "approve_or_reject");
  assert.equal(attention.items[0]?.review?.stats.files_changed, 2);
  assert.equal(attention.items[0]?.review?.files[0]?.path, "/tmp/demo/services/payments/router.ts");
  assert.match(attention.items[0]?.review?.review_hint ?? "", /update payment handlers/i);

  const approvalDetail = dashboard.getApprovalDetail(attention.items[0]!.approval_id);
  assert.equal(approvalDetail?.review?.suggested_actions[1], "Approve all");

  const continueWorking = dashboard.getContinueWorking();
  assert.ok(continueWorking.items.some((item) => item.kind === "managed_session"));
  assert.ok(continueWorking.items.some((item) => item.kind === "recent_work"));

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service uses cached model-backed continue summaries when available", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
    providers: [{
      id: "claude",
      isAvailable: () => true,
      summarize: async () => ({
        items: [{
          id: "recent_1",
          title: "Resume API bootstrap",
          summary: "Continue the bootstrap work from the latest imported context.",
        }],
      }),
    }],
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  storage.upsertRecentWork({
    id: "recent_1",
    source_path: "/tmp/recent.jsonl",
    project_path: "/tmp/demo",
    title: "Long imported raw title from transcript",
    summary: "Long imported raw summary from transcript",
    source_type: "claude-session",
    status: "ended",
    updated_at: new Date().toISOString(),
    metadata: {
      last_agent_message: "Please continue the bootstrap work and keep the spec aligned.",
    },
  });

  const first = dashboard.getContinueWorking();
  assert.equal(first.items[0]?.title, "Long imported raw title from transcript");

  summaries.prepareContinueCard(
    storage.getRecentWork("recent_1")!,
    "Long imported raw title from transcript",
    "Long imported raw summary from transcript",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = dashboard.getContinueWorking();
  assert.equal(second.items[0]?.title, "Resume API bootstrap");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service includes Claude Cowork observed sessions in continue working", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-cowork-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    claudeDesktopPath: join(root, "missing-claude-desktop"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  storage.upsertRecentWork({
    id: "cowork_1",
    source_path: "/tmp/cowork/local_session.json",
    project_path: "/tmp/demo",
    title: "Redesign landing page for startup",
    summary: "Please look at async-buddy/apps/web and redesign the landing page for Buddy.",
    source_type: "claude-desktop-session",
    status: "active",
    updated_at: new Date().toISOString(),
    metadata: {
      runtime_label: "Claude Cowork",
      last_user_message: "Please look at async-buddy/apps/web and redesign the landing page for Buddy.",
    },
  });

  const continueWorking = dashboard.getContinueWorking();
  const observed = continueWorking.items.find((item) => item.kind === "recent_work" && item.recent_work_id === "cowork_1");

  assert.ok(observed);
  assert.equal(observed?.source_type, "claude-desktop-session");
  assert.equal(observed?.title, "Redesign landing page for startup");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service hides managed runtime transcripts from continue working", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  const task = tasks.create({
    title: "Managed Codex follow-up",
    description: "Continue the daemon-owned Codex work.",
    project_path: "/tmp/demo",
    agent_type: "codex",
  });
  const session = sessions.createFromTask(task, "codex-cli");
  sessions.mergeMetadata(session.id, {
    codex_session_id: "codex-managed-1",
  });

  storage.upsertRecentWork({
    id: "codex-managed-1",
    source_path: "/tmp/codex-managed.jsonl",
    project_path: "/tmp/demo",
    title: "Managed transcript should stay hidden",
    summary: "Managed transcript duplicate.",
    source_type: "codex-session-file",
    status: "active",
    updated_at: new Date().toISOString(),
    metadata: {
      last_user_message: "Managed transcript duplicate.",
    },
  });
  storage.upsertRecentWork({
    id: "codex-observed-1",
    source_path: "/tmp/codex-observed.jsonl",
    project_path: "/tmp/demo",
    title: "Observed transcript should stay visible",
    summary: "Observed transcript.",
    source_type: "codex-session-file",
    status: "ended",
    updated_at: new Date().toISOString(),
    metadata: {
      last_user_message: "Observed transcript.",
    },
  });

  const continueWorking = dashboard.getContinueWorking();
  assert.ok(continueWorking.items.some((item) => item.kind === "managed_session" && item.session_id === session.id));
  assert.ok(!continueWorking.items.some((item) => item.kind === "recent_work" && item.recent_work_id === "codex-managed-1"));
  assert.ok(continueWorking.items.some((item) => item.kind === "recent_work" && item.recent_work_id === "codex-observed-1"));

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service hides internal Codex artifact sessions from continue working", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  storage.upsertRecentWork({
    id: "codex-internal-task",
    source_path: "/tmp/codex-internal-task.jsonl",
    project_path: "/tmp/demo",
    title: "Task: Continue: Correct observed session timestamps",
    summary: "Internal managed task prompt.",
    source_type: "codex-session-file",
    status: "ended",
    updated_at: new Date().toISOString(),
    metadata: {
      raw_user_input: "Task: Continue: Correct observed session timestamps\n\nContinue the managed session from its latest completed state.",
      last_user_message: "Task: Continue: Correct observed session timestamps\n\nContinue the managed session from its latest completed state.",
    },
  });
  storage.upsertRecentWork({
    id: "codex-summary-batch",
    source_path: "/tmp/codex-summary-batch.jsonl",
    project_path: "/tmp/demo",
    title: "Rewrite recent work into compact mobile cards for Asynq Buddy.",
    summary: "Internal summary batch prompt.",
    source_type: "codex-session-file",
    status: "ended",
    updated_at: new Date().toISOString(),
    metadata: {
      raw_user_input: "Rewrite recent work into compact mobile cards for Asynq Buddy.",
    },
  });
  storage.upsertRecentWork({
    id: "codex-real-observed",
    source_path: "/tmp/codex-real-observed.jsonl",
    project_path: "/tmp/demo",
    title: "Correct observed session timestamps",
    summary: "Observed transcript.",
    source_type: "codex-session-file",
    status: "ended",
    updated_at: new Date().toISOString(),
    metadata: {
      last_user_message: "Correct observed session timestamps",
      last_agent_message: "Observed transcript.",
    },
  });

  const continueWorking = dashboard.getContinueWorking();
  assert.ok(!continueWorking.items.some((item) => item.kind === "recent_work" && item.recent_work_id === "codex-internal-task"));
  assert.ok(!continueWorking.items.some((item) => item.kind === "recent_work" && item.recent_work_id === "codex-summary-batch"));
  assert.ok(continueWorking.items.some((item) => item.kind === "recent_work" && item.recent_work_id === "codex-real-observed"));

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service keeps managed parent sessions visible and links child sessions to managed parent", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  storage.upsertRecentWork({
    id: "recent_observed_1",
    source_path: "/tmp/observed.jsonl",
    project_path: "/tmp/demo",
    title: "Observed thread",
    summary: "Observed summary.",
    source_type: "codex-session-file",
    status: "ended",
    updated_at: new Date().toISOString(),
    metadata: {
      last_user_message: "Observed thread",
      last_agent_message: "Observed summary.",
    },
  });

  const rootTask = tasks.create({
    title: "Managed follow-up",
    description: "First managed session.",
    project_path: "/tmp/demo",
    agent_type: "codex",
    context: {
      source_recent_work_id: "recent_observed_1",
    },
  });
  const rootSession = sessions.createFromTask(rootTask, "codex-cli");
  sessions.transition(rootSession.id, "completed");
  tasks.update(rootTask.id, {
    status: "completed",
    assigned_session_id: rootSession.id,
  });

  const childTask = tasks.create({
    title: "Managed follow-up",
    description: "Continuation without direct source_recent_work_id.",
    project_path: "/tmp/demo",
    agent_type: "codex",
    context: {
      parent_session_id: rootSession.id,
    },
  });
  const childSession = sessions.createFromTask(childTask, "codex-cli");
  sessions.transition(childSession.id, "completed");
  tasks.update(childTask.id, {
    status: "completed",
    assigned_session_id: childSession.id,
  });

  const managedSessions = dashboard.getManagedSessions();
  assert.ok(managedSessions.items.some((item) => item.session_id === rootSession.id));
  assert.ok(managedSessions.items.some((item) => item.session_id === childSession.id));

  const childCard = managedSessions.items.find((item) => item.session_id === childSession.id);
  assert.equal(childCard?.source_observed_id, rootSession.id);
  assert.equal(childCard?.source_session_kind, "managed");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service exposes observed Codex approval requests in attention required", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  storage.upsertRecentWork({
    id: "recent_observed_review",
    source_path: "/tmp/observed-review.jsonl",
    project_path: "/tmp/demo",
    title: "Observed cleanup thread",
    summary: "Waiting on an escalated cleanup command.",
    source_type: "codex-session-file",
    status: "active",
    updated_at: new Date().toISOString(),
    metadata: {
      last_user_message: "Clean up legacy rows",
      last_agent_message: "Waiting on approval before the cleanup can continue.",
      pending_observed_review: {
        action: "Approve command: node cleanup.js",
        context: "Do you want me to delete the legacy managed-session rows from ~/.asynq-agentd?",
        cmd: "node cleanup.js",
      },
    },
  });

  const overview = dashboard.getOverview();
  assert.equal(overview.counts.approvals_pending, 1);

  const attention = dashboard.getAttentionRequired();
  assert.equal(attention.items.length, 1);
  assert.equal(attention.items[0]?.approval_id, "observed-review:recent_observed_review");
  assert.equal(attention.items[0]?.can_resolve, false);
  assert.equal(attention.items[0]?.recent_work_id, "recent_observed_review");
  assert.equal(attention.items[0]?.review?.source_session_kind, "observed");

  const approvalDetail = dashboard.getApprovalDetail("observed-review:recent_observed_review");
  assert.equal(approvalDetail?.review?.command, "node cleanup.js");

  const continueWorking = dashboard.getContinueWorking();
  const observed = continueWorking.items.find((item) => item.kind === "recent_work" && item.recent_work_id === "recent_observed_review");
  assert.equal(observed?.observed_approval_id, "observed-review:recent_observed_review");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service suppresses observed approval once a managed takeover exists", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  storage.upsertRecentWork({
    id: "recent_observed_review_hidden",
    source_path: "/tmp/observed-review-hidden.jsonl",
    project_path: "/tmp/demo",
    title: "Observed cleanup thread",
    summary: "Waiting on approval before cleanup.",
    source_type: "codex-session-file",
    status: "active",
    updated_at: new Date().toISOString(),
    metadata: {
      pending_observed_review: {
        action: "Approve command: cp ~/.asynq-agentd/asynq-agentd.sqlite ~/.asynq-agentd/asynq-agentd.sqlite.backup-test",
        context: "Do you want me to back up your agentd SQLite database?",
        cmd: "cp ~/.asynq-agentd/asynq-agentd.sqlite ~/.asynq-agentd/asynq-agentd.sqlite.backup-test",
        detected_at: "2026-03-28T01:00:00.000Z",
      },
    },
  });

  const task = tasks.create({
    title: "Continue observed cleanup",
    description: "Take over the observed cleanup flow.",
    project_path: "/tmp/demo",
    agent_type: "codex",
    context: {
      source_recent_work_id: "recent_observed_review_hidden",
    },
  });
  const session = sessions.createFromTask(task, "codex-cli");
  tasks.update(task.id, {
    status: "running",
    assigned_session_id: session.id,
  });

  const attention = dashboard.getAttentionRequired();
  assert.equal(attention.items.length, 0);

  const continueWorking = dashboard.getContinueWorking();
  const observed = continueWorking.items.find((item) => item.kind === "recent_work" && item.recent_work_id === "recent_observed_review_hidden");
  assert.equal(observed?.observed_approval_id, undefined);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service keeps a newer observed approval visible despite an older completed takeover", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  storage.upsertRecentWork({
    id: "recent_observed_review_newer",
    source_path: "/tmp/observed-review-newer.jsonl",
    project_path: "/tmp/demo",
    title: "Observed cleanup thread",
    summary: "Waiting on a fresh approval.",
    source_type: "codex-session-file",
    status: "active",
    updated_at: "2026-03-28T01:10:00.000Z",
    metadata: {
      pending_observed_review: {
        action: "Approve command: cp ~/.asynq-agentd/asynq-agentd.sqlite ~/.asynq-agentd/asynq-agentd.sqlite.backup-test",
        context: "Do you want me to back up your agentd SQLite database?",
        cmd: "cp ~/.asynq-agentd/asynq-agentd.sqlite ~/.asynq-agentd/asynq-agentd.sqlite.backup-test",
        detected_at: "2026-03-28T01:10:00.000Z",
      },
    },
  });

  const task = tasks.create({
    title: "Earlier observed cleanup takeover",
    description: "Older follow-up that already completed.",
    project_path: "/tmp/demo",
    agent_type: "codex",
    context: {
      source_recent_work_id: "recent_observed_review_newer",
    },
  });
  const session = sessions.createFromTask(task, "codex-cli");
  tasks.update(task.id, {
    status: "completed",
    assigned_session_id: session.id,
  });
  storage.upsertTask({
    ...(storage.getTask(task.id) ?? task),
    updated_at: "2026-03-28T01:05:00.000Z",
  });
  storage.upsertSession({
    ...(storage.getSession(session.id) ?? session),
    updated_at: "2026-03-28T01:05:00.000Z",
  });

  const attention = dashboard.getAttentionRequired();
  assert.equal(attention.items.length, 1);
  assert.equal(attention.items[0]?.approval_id, "observed-review:recent_observed_review_newer");

  const continueWorking = dashboard.getContinueWorking();
  const observed = continueWorking.items.find((item) => item.kind === "recent_work" && item.recent_work_id === "recent_observed_review_newer");
  assert.equal(observed?.observed_approval_id, "observed-review:recent_observed_review_newer");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service hides stale linked managed takeover once observed work is newer", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-stale-takeover-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    claudeDesktopPath: join(root, "missing-claude-desktop"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  storage.upsertRecentWork({
    id: "recent_observed",
    source_path: "/tmp/recent.jsonl",
    project_path: "/tmp/demo",
    title: "Correct observed session timestamps",
    summary: "Observed work continued after the failed takeover.",
    source_type: "codex-session-file",
    status: "active",
    updated_at: "2026-04-07T12:05:00.000Z",
    metadata: {},
  });

  const task = tasks.create({
    title: "Continue: Correct observed session timestamps",
    description: "Take over the observed session.",
    project_path: "/tmp/demo",
    agent_type: "codex",
    context: {
      source_recent_work_id: "recent_observed",
    },
  });
  storage.upsertTask({
    ...task,
    status: "failed",
    updated_at: "2026-03-28T02:24:00.000Z",
  });

  const continueWorking = dashboard.getContinueWorking();
  const observed = continueWorking.items.find((item) => item.kind === "recent_work" && item.recent_work_id === "recent_observed");
  const detail = dashboard.getRecentWorkDetail("recent_observed");

  assert.ok(observed);
  assert.equal(observed?.linked_managed_session_id, undefined);
  assert.equal(observed?.linked_managed_status, undefined);
  assert.equal(detail?.takeover, undefined);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service filters noisy and duplicate continue items", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
    providers: [],
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  storage.upsertRecentWork({
    id: "codex-1",
    source_path: "/tmp/codex-1.jsonl",
    project_path: "/tmp/demo",
    title: "Continue Codex",
    summary: "Codex has resumable recent work ready to pick up.",
    source_type: "codex-session-file",
    status: "ended",
    updated_at: "2026-03-21T10:00:00.000Z",
    metadata: {
      last_user_message: "Zablokujte done bez ownera",
      last_reasoning_summary: "Block done transitions unless an owner is assigned.",
    },
  });

  storage.upsertRecentWork({
    id: "codex-2",
    source_path: "/tmp/codex-2.jsonl",
    project_path: "/tmp/demo",
    title: "Continue Codex",
    summary: "Codex has resumable recent work ready to pick up.",
    source_type: "codex-session-file",
    status: "ended",
    updated_at: "2026-03-21T11:00:00.000Z",
    metadata: {
      last_user_message: "Zablokujte done bez ownera",
      last_reasoning_summary: "Block done transitions unless an owner is assigned.",
    },
  });

  storage.upsertRecentWork({
    id: "claude-json",
    source_path: "/tmp/claude.json",
    project_path: "/tmp/demo",
    title: "{",
    summary: "{\"display\":\"login\"}",
    source_type: "claude-file",
    status: "unknown",
    updated_at: "2026-03-21T12:00:00.000Z",
    metadata: {},
  });

  storage.upsertRecentWork({
    id: "codex-encrypted",
    source_path: "/tmp/codex-3.jsonl",
    project_path: "/tmp/demo",
    title: "Continue Codex",
    summary: "gAAAAAExampleEncryptedBlobThatShouldNeverShowUp",
    source_type: "codex-session-file",
    status: "ended",
    updated_at: "2026-03-21T13:00:00.000Z",
    metadata: {
      last_user_message: "Continue Codex",
    },
  });

  const continueWorking = dashboard.getContinueWorking();
  assert.equal(continueWorking.items.length, 2);
  assert.ok(continueWorking.items.every((item) => item.kind === "recent_work"));
  assert.ok(continueWorking.items.every((item) => /owner/i.test(item.title)));
  assert.ok(continueWorking.items.every((item) => !/^Continue Codex$/i.test(item.title)));

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service refreshes recent-work detail from disk before returning observed detail", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const codexPath = join(root, "codex");
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath,
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
    providers: [],
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  const sessionDir = join(codexPath, "sessions", "2026", "03", "24");
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, "session-1.jsonl");

  writeFileSync(sessionPath, [
    JSON.stringify({ type: "session_meta", payload: { id: "session-1", cwd: "/tmp/demo" } }),
    JSON.stringify({ type: "user_message", payload: { text: "Fix the dashboard session detail" } }),
    JSON.stringify({ type: "agent_message", payload: { message: "Initial observed summary" } }),
  ].join("\n"));
  recentWork.scan();

  writeFileSync(sessionPath, [
    JSON.stringify({ type: "session_meta", payload: { id: "session-1", cwd: "/tmp/demo" } }),
    JSON.stringify({ type: "user_message", payload: { text: "Fix the dashboard session detail" } }),
    JSON.stringify({ type: "agent_message", payload: { message: "Fresh observed summary after more work" } }),
  ].join("\n"));

  const detail = dashboard.getRecentWorkDetail("session-1");
  assert.equal(detail?.summary, "Fresh observed summary after more work");
  assert.equal(detail?.raw_agent_response, "Fresh observed summary after more work");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service marks observed approvals outside the workspace as desktop-only", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates: createTestUpdates(),
  });

  storage.upsertRecentWork({
    id: "observed-outside-workspace",
    source_path: "/tmp/observed-outside.jsonl",
    project_path: "/tmp/demo",
    title: "Observed backup approval",
    summary: "Need permission to back up sqlite.",
    source_type: "codex-session-file",
    status: "active",
    updated_at: "2026-03-28T01:33:22.000Z",
    metadata: {
      last_user_message: "Create a backup of the agentd sqlite file.",
      last_agent_message: "Waiting for permission to write outside the workspace.",
      pending_observed_review: {
        action: "Approve command: cp /Users/asynqroot/.asynq-agentd/asynq-agentd.sqlite /Users/asynqroot/.asynq-agentd/asynq-agentd.sqlite.backup",
        context: "This command writes outside the project workspace.",
        cmd: "cp /Users/asynqroot/.asynq-agentd/asynq-agentd.sqlite /Users/asynqroot/.asynq-agentd/asynq-agentd.sqlite.backup",
        detected_at: "2026-03-28T01:33:22.000Z",
        success_checks: [
          {
            kind: "command_exit_zero",
            cmd: "cp /Users/asynqroot/.asynq-agentd/asynq-agentd.sqlite /Users/asynqroot/.asynq-agentd/asynq-agentd.sqlite.backup",
          },
          {
            kind: "path_exists",
            path: "/Users/asynqroot/.asynq-agentd/asynq-agentd.sqlite.backup",
            path_type: "file",
          },
        ],
      },
    },
  });

  const detail = dashboard.getApprovalDetail("observed-review:observed-outside-workspace");
  assert.equal(detail?.review?.takeover_supported, false);
  assert.equal(detail?.review?.show_stats, false);
  assert.match(detail?.review?.takeover_reason ?? "", /outside the managed workspace/i);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("dashboard service exposes agentd and Buddy compatibility updates in attention required", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const runtimes = new RuntimeDiscoveryService();
  const summaries = new SummaryService({
    storage,
    runtimes,
    getConfig: () => createDefaultConfig(),
  });
  const updates = new UpdateService({
    currentVersion: "0.4.0",
    minSupportedBuddyVersion: "0.2.0",
    fetchImpl: async () => new Response(JSON.stringify({
      tag_name: "v0.5.0",
      html_url: "https://example.com/releases/v0.5.0",
      body: "New release with update support.",
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
    summaries,
    runtimes,
    updates,
  });

  await updates.checkNow();
  const attention = dashboard.getAttentionRequired({
    app_version: "0.1.0",
    min_supported_agentd_version: "0.5.0",
  });

  assert.equal(attention.items.length, 3);
  assert.deepEqual(
    attention.items.map((item) => item.approval_id).sort(),
    ["update:agentd", "update:agentd-compatibility", "update:buddy"],
  );
  const agentdUpdate = attention.items.find((item) => item.approval_id === "update:agentd");
  assert.equal(agentdUpdate?.update?.latest_version, "0.5.0");

  const overview = dashboard.getOverview({
    app_version: "0.1.0",
    min_supported_agentd_version: "0.5.0",
  });
  assert.equal(overview.counts.approvals_pending, 3);
  assert.equal(overview.compatibility?.requires_buddy_update, true);
  assert.equal(overview.compatibility?.requires_agentd_update, true);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});
