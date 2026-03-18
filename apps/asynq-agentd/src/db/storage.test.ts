import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsynqAgentdStorage } from "./storage.ts";
import type { SessionRecord, TaskRecord } from "../domain.ts";

test("storage persists tasks and sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-storage-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));

  const task: TaskRecord = {
    id: "task_1",
    title: "Bootstrap daemon",
    description: "Create the first runtime slice",
    agent_type: "custom",
    project_path: "/tmp/project",
    priority: "high",
    depends_on: [],
    approval_required: false,
    status: "queued",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  storage.upsertTask(task);

  const session: SessionRecord = {
    id: "sess_1",
    task_id: task.id,
    title: task.title,
    agent_type: task.agent_type,
    project_path: task.project_path,
    state: "working",
    adapter: "mock",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: { seed: true },
  };
  storage.upsertSession(session);

  assert.equal(storage.listTasks().length, 1);
  assert.equal(storage.listSessions().length, 1);
  assert.equal(storage.getSessionDetail(session.id)?.task?.id, task.id);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});
