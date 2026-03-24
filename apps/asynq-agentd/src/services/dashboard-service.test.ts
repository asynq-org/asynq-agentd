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
import { createDefaultConfig } from "../config.ts";

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
