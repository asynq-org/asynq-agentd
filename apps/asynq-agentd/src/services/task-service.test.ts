import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
