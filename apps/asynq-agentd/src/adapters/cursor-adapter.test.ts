import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ActivityPayload, SessionRecord, TaskRecord } from "../domain.ts";
import { CursorCliAdapter } from "./cursor-adapter.ts";

function baseTask(projectPath: string): TaskRecord {
  return {
    id: "task_cursor",
    title: "Implement Cursor adapter",
    description: "Run Cursor Agent headlessly.",
    agent_type: "cursor",
    project_path: projectPath,
    priority: "normal",
    depends_on: [],
    approval_required: false,
    status: "queued",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function baseSession(projectPath: string): SessionRecord {
  return {
    id: "sess_cursor",
    task_id: "task_cursor",
    title: "Implement Cursor adapter",
    agent_type: "cursor",
    project_path: projectPath,
    state: "working",
    adapter: "cursor-cli",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    metadata: {},
  };
}

test("cursor adapter streams activity and stores session metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-cursor-"));
  const scriptPath = resolve(root, "fake-cursor.mjs");
  writeFileSync(scriptPath, `#!/usr/bin/env node
const out = (value) => console.log(JSON.stringify(value));
out({ type: "system", subtype: "init", session_id: "cursor-chat-1", model: "auto" });
out({ type: "assistant", message: { content: [{ type: "text", text: "Planning Cursor work" }] } });
out({ type: "tool_call", subtype: "started", tool_call_id: "tool-1", tool_call: { shellToolCall: { args: { command: "npm test" } } } });
out({ type: "tool_call", subtype: "completed", tool_call_id: "tool-1", duration_ms: 12, tool_call: { shellToolCall: { args: { command: "npm test" } }, result: { exitCode: 0, output: "ok" } } });
out({ type: "result", result: "Done", model: "auto", duration_ms: 20 });
`);
  chmodSync(scriptPath, 0o755);

  const adapter = new CursorCliAdapter({ binPath: process.execPath, binArgs: [scriptPath] });
  const events: ActivityPayload[] = [];
  const patches: Record<string, unknown>[] = [];
  await adapter.runTask(baseTask(root), baseSession(root), {
    onEvent: (payload) => events.push(payload),
    onSessionPatch: (patch) => patches.push(patch),
    onTerminalData: () => {},
  });

  assert.ok(patches.some((patch) => patch.cursor_session_id === "cursor-chat-1"));
  assert.ok(events.some((event) => event.type === "command_intent" && event.cmd === "npm test"));
  assert.ok(events.some((event) => event.type === "command_run" && event.cmd === "npm test"));
  assert.ok(events.some((event) => event.type === "agent_output" && event.message === "Done"));

  rmSync(root, { recursive: true, force: true });
});

test("cursor adapter resumes an existing conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-cursor-"));
  const scriptPath = resolve(root, "fake-cursor-resume.mjs");
  writeFileSync(scriptPath, `#!/usr/bin/env node
if (!process.argv.includes("--resume") || !process.argv.includes("cursor-chat-1")) {
  console.error(process.argv.join(" "));
  process.exit(2);
}
console.log(JSON.stringify({ type: "result", result: "Resumed" }));
`);
  chmodSync(scriptPath, 0o755);

  const adapter = new CursorCliAdapter({ binPath: process.execPath, binArgs: [scriptPath] });
  const result = await adapter.appendToConversation("cursor-chat-1", "Continue", { projectPath: root });
  assert.equal(result.lastMessage, "Resumed");

  rmSync(root, { recursive: true, force: true });
});
