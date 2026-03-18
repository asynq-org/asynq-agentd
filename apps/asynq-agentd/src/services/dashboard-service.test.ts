import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsynqAgentdStorage } from "../db/storage.ts";
import { TaskService } from "./task-service.ts";
import { SessionService } from "./session-service.ts";
import { RecentWorkService } from "./recent-work-service.ts";
import { DashboardService } from "./dashboard-service.ts";

test("dashboard service returns overview, attention cards, and continue items", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-dashboard-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const sessions = new SessionService(storage);
  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: join(root, "missing-claude"),
    codexPath: join(root, "missing-codex"),
  });
  const dashboard = new DashboardService({
    storage,
    tasks,
    sessions,
    recentWork,
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
  assert.equal(overview.sessions.length, 1);
  assert.match(overview.sessions[0]?.summary ?? "", /Modify 12 files/i);

  const attention = dashboard.getAttentionRequired();
  assert.equal(attention.items.length, 1);
  assert.equal(attention.items[0]?.next_action, "approve_or_reject");

  const continueWorking = dashboard.getContinueWorking();
  assert.ok(continueWorking.items.some((item) => item.kind === "managed_session"));
  assert.ok(continueWorking.items.some((item) => item.kind === "recent_work"));

  storage.close();
  rmSync(root, { recursive: true, force: true });
});
