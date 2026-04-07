import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { AsynqAgentdStorage } from "../db/storage.ts";
import { TaskService } from "./task-service.ts";

test("task service rejects relative project paths", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-task-service-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);

  assert.throws(() => {
    tasks.create({
      title: "Bad task",
      description: "Should fail validation",
      project_path: "./relative/path",
    });
  }, /absolute path/);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("task service merges .asynq-agentd.yaml defaults into task context", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-task-service-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(resolve(projectRoot, ".asynq-agentd.yaml"), [
    "project:",
    "  test_command: pnpm test",
    "  context_files:",
    "    - CLAUDE.md",
    "    - docs/architecture.md",
    "",
  ].join("\n"));

  const task = tasks.create({
    title: "Config-aware task",
    description: "Should inherit project defaults",
    project_path: projectRoot,
    context: {
      files_to_focus: ["README.md"],
    },
  });

  assert.equal(task.context?.test_command, "pnpm test");
  assert.deepEqual(task.context?.files_to_focus, ["CLAUDE.md", "docs/architecture.md", "README.md"]);
  assert.equal(task.approval_required, false);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("task service uses project defaults for model and approval", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-task-service-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(resolve(projectRoot, ".asynq-agentd.yaml"), [
    "project:",
    "  default_model_preference: claude-opus",
    "  default_approval_required: true",
    "",
  ].join("\n"));

  const task = tasks.create({
    title: "Defaulted task",
    description: "Should inherit model and approval defaults",
    project_path: projectRoot,
  });

  assert.equal(task.model_preference, "claude-opus");
  assert.equal(task.approval_required, true);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("task service falls back to a default Buddy workspace when project path is omitted", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-task-service-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
    const tasks = new TaskService(storage);

    const task = tasks.create({
      title: "Research market",
      description: "Do a broad market scan.",
    });

    assert.equal(task.project_path, resolve(homedir(), ".asynq-agentd/workspaces/general"));
    assert.equal(existsSync(task.project_path), true);

    storage.close();
  } finally {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("task service creates custom project directories when needed", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-task-service-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const targetProject = resolve(root, "new-project-space");

  const task = tasks.create({
    title: "Bootstrap folder",
    description: "Create a new workspace if needed.",
    project_path: targetProject,
  });

  assert.equal(task.project_path, targetProject);
  assert.equal(existsSync(targetProject), true);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("task service deletes a top-level managed session tree", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-task-service-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);

  const rootTask = tasks.create({
    title: "Top-level managed",
    description: "Standalone managed root.",
    project_path: resolve(root, "project"),
    agent_type: "codex",
  });
  const rootSession = storage.upsertSession({
    id: "sess_root",
    task_id: rootTask.id,
    title: rootTask.title,
    agent_type: "codex",
    project_path: rootTask.project_path,
    state: "completed",
    adapter: "codex-cli",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {},
  });
  tasks.update(rootTask.id, {
    assigned_session_id: rootSession.id,
    status: "completed",
  });

  const childTask = tasks.create({
    title: "Top-level managed",
    description: "Continuation child.",
    project_path: rootTask.project_path,
    agent_type: "codex",
    context: {
      parent_session_id: rootSession.id,
      previous_session_id: "resume-id",
    },
  });
  const childSession = storage.upsertSession({
    id: "sess_child",
    task_id: childTask.id,
    title: childTask.title,
    agent_type: "codex",
    project_path: childTask.project_path,
    state: "completed",
    adapter: "codex-cli",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {},
  });
  tasks.update(childTask.id, {
    assigned_session_id: childSession.id,
    status: "completed",
  });

  storage.upsertApproval({
    id: "approval_1",
    session_id: childSession.id,
    action: "Approve child work",
    context: "Review child work",
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  storage.insertActivity(childSession.id, new Date().toISOString(), {
    type: "agent_output",
    message: "Child output",
  });
  storage.insertTerminalEvent(childSession.id, new Date().toISOString(), "stdout", "{\"type\":\"thread.started\"}\n");

  const deleted = tasks.deleteManagedSessionTree(rootSession.id);
  assert.deepEqual(new Set(deleted.deleted_session_ids), new Set([rootSession.id, childSession.id]));
  assert.deepEqual(new Set(deleted.deleted_task_ids), new Set([rootTask.id, childTask.id]));
  assert.equal(storage.getSession(rootSession.id), undefined);
  assert.equal(storage.getSession(childSession.id), undefined);
  assert.equal(storage.getTask(rootTask.id), undefined);
  assert.equal(storage.getTask(childTask.id), undefined);
  assert.equal(storage.listApprovals().length, 0);
  assert.equal(storage.listActivity({ session_id: childSession.id }).length, 0);
  assert.equal(storage.listTerminalEvents(childSession.id).length, 0);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("task service deletes a standalone managed chain even when called from the latest continuation", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-task-service-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);

  const rootTask = tasks.create({
    title: "Standalone managed",
    description: "Root session.",
    project_path: resolve(root, "project"),
    agent_type: "codex",
  });
  const rootSession = storage.upsertSession({
    id: "sess_root_latest",
    task_id: rootTask.id,
    title: rootTask.title,
    agent_type: "codex",
    project_path: rootTask.project_path,
    state: "completed",
    adapter: "codex-cli",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {},
  });
  tasks.update(rootTask.id, {
    assigned_session_id: rootSession.id,
    status: "completed",
  });

  const childTask = tasks.create({
    title: "Standalone managed",
    description: "Latest continuation.",
    project_path: rootTask.project_path,
    agent_type: "codex",
    context: {
      parent_session_id: rootSession.id,
      previous_session_id: "resume-id",
    },
  });
  const childSession = storage.upsertSession({
    id: "sess_child_latest",
    task_id: childTask.id,
    title: childTask.title,
    agent_type: "codex",
    project_path: childTask.project_path,
    state: "completed",
    adapter: "codex-cli",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {},
  });
  tasks.update(childTask.id, {
    assigned_session_id: childSession.id,
    status: "completed",
  });

  const deleted = tasks.deleteManagedSessionTree(childSession.id);
  assert.deepEqual(new Set(deleted.deleted_session_ids), new Set([rootSession.id, childSession.id]));
  assert.deepEqual(new Set(deleted.deleted_task_ids), new Set([rootTask.id, childTask.id]));
  assert.equal(storage.getSession(rootSession.id), undefined);
  assert.equal(storage.getSession(childSession.id), undefined);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});
