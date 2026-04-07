import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CodexCliAdapter } from "./codex-adapter.ts";
import type { ActivityPayload, SessionRecord, TaskRecord } from "../domain.ts";

function createTask(projectPath: string, previousSessionId?: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "task_1",
    title: "Implement Codex adapter",
    description: "Run the real Codex CLI and persist session metadata.",
    agent_type: "codex",
    project_path: projectPath,
    priority: "normal",
    depends_on: [],
    approval_required: false,
    status: "queued",
    created_at: now,
    updated_at: now,
    context: previousSessionId ? { previous_session_id: previousSessionId } : undefined,
  };
}

function createSession(projectPath: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: "sess_1",
    title: "Implement Codex adapter",
    agent_type: "codex",
    project_path: projectPath,
    state: "working",
    adapter: "codex-cli",
    created_at: now,
    updated_at: now,
    metadata: {},
  };
}

test("codex adapter streams activity and stores session metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-codex-"));
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const argvFile = resolve(root, "argv.json");
  const scriptPath = resolve(root, "fake-codex.mjs");

  writeFileSync(scriptPath, `
import { writeFileSync } from "node:fs";

writeFileSync(process.env.ASYNQ_AGENTD_ARGV_FILE, JSON.stringify(process.argv.slice(2), null, 2));
console.log(JSON.stringify({
  timestamp: "2026-03-16T09:00:00.000Z",
  type: "session_meta",
  payload: {
    id: "019cda49-9e87-7a13-a4e8-7dddb62a9d99",
    cwd: process.cwd(),
    cli_version: "0.108.0-alpha.12"
  }
}));
console.log(JSON.stringify({
  timestamp: "2026-03-16T09:00:01.000Z",
  type: "event_msg",
  payload: {
    type: "agent_message",
    message: "Working on the requested task."
  }
}));
console.log(JSON.stringify({
  timestamp: "2026-03-16T09:00:02.000Z",
  type: "response_item",
  payload: {
    type: "function_call",
    name: "exec_command",
    call_id: "call_exec",
    arguments: JSON.stringify({ cmd: "pnpm test" })
  }
}));
console.log(JSON.stringify({
  timestamp: "2026-03-16T09:00:03.000Z",
  type: "response_item",
  payload: {
    type: "function_call_output",
    call_id: "call_exec",
    output: "Chunk ID: demo\\nWall time: 0.321 seconds\\nProcess exited with code 0\\nOutput:\\nℹ pass 5\\nℹ fail 0\\nℹ skipped 1\\n"
  }
}));
console.log(JSON.stringify({
  timestamp: "2026-03-16T09:00:04.000Z",
  type: "response_item",
  payload: {
    type: "custom_tool_call",
    name: "apply_patch",
    call_id: "call_patch",
    input: "*** Begin Patch\\n*** Update File: /tmp/example.ts\\n@@\\n-console.log('before');\\n+console.log('after');\\n*** End Patch\\n"
  }
}));
console.log(JSON.stringify({
  timestamp: "2026-03-16T09:00:05.000Z",
  type: "response_item",
  payload: {
    type: "custom_tool_call_output",
    call_id: "call_patch",
    output: JSON.stringify({
      output: "Success. Updated the following files:\\nM /tmp/example.ts\\n",
      metadata: {
        exit_code: 0,
        duration_seconds: 0.01
      }
    })
  }
}));
console.log(JSON.stringify({
  timestamp: "2026-03-16T09:00:06.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: 100,
        output_tokens: 50,
        reasoning_output_tokens: 10
      }
    }
  }
}));
`, "utf8");

  const adapter = new CodexCliAdapter({
    binPath: process.execPath,
    binArgs: [scriptPath],
    codexHome: resolve(root, ".codex"),
    env: {
      ASYNQ_AGENTD_ARGV_FILE: argvFile,
    },
  });

  const events: ActivityPayload[] = [];
  const patches: Record<string, unknown>[] = [];
  await adapter.runTask(createTask(projectRoot), createSession(projectRoot), {
    onEvent: (payload) => {
      events.push(payload);
    },
    onSessionPatch: (patch) => {
      patches.push(patch);
    },
    onTerminalData: () => {},
  });

  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.ok(argv.includes("exec"));
  assert.ok(argv.includes("--json"));
  assert.ok(argv.includes("--cd"));
  assert.ok(argv.includes(projectRoot));
  assert.ok(events.some((payload) => payload.type === "agent_output" && payload.message === "Working on the requested task."));
  assert.ok(events.some((payload) => payload.type === "agent_thinking"));
  assert.ok(events.some((payload) => payload.type === "command_intent" && payload.cmd === "pnpm test"));
  assert.ok(events.some((payload) => payload.type === "command_run" && payload.cmd === "pnpm test"));
  assert.ok(events.some((payload) => payload.type === "test_run" && payload.passed === 5));
  assert.ok(events.some((payload) => payload.type === "file_batch_intent"));
  assert.ok(events.some((payload) => payload.type === "file_edit" && payload.path === "/tmp/example.ts"));
  assert.ok(events.some((payload) => payload.type === "model_call" && payload.tokens_out === 60));
  assert.ok(patches.some((patch) => patch.codex_session_id === "019cda49-9e87-7a13-a4e8-7dddb62a9d99"));

  rmSync(root, { recursive: true, force: true });
});

test("codex adapter resumes from previous session id when provided", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-codex-"));
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const argvFile = resolve(root, "argv.json");
  const scriptPath = resolve(root, "fake-codex.mjs");

  writeFileSync(scriptPath, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ASYNQ_AGENTD_ARGV_FILE, JSON.stringify(process.argv.slice(2), null, 2));
`, "utf8");

  const adapter = new CodexCliAdapter({
    binPath: process.execPath,
    binArgs: [scriptPath],
    codexHome: resolve(root, ".codex"),
    env: {
      ASYNQ_AGENTD_ARGV_FILE: argvFile,
    },
  });

  await adapter.runTask(
    createTask(projectRoot, "019cda49-9e87-7a13-a4e8-7dddb62a9d99"),
    createSession(projectRoot),
    {
      onEvent: () => {},
      onSessionPatch: () => {},
      onTerminalData: () => {},
    },
  );

  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.deepEqual(argv.slice(0, 5), [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "019cda49-9e87-7a13-a4e8-7dddb62a9d99",
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("codex adapter stores session id from thread.started events", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-codex-"));
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const scriptPath = resolve(root, "fake-codex-thread-started.mjs");

  writeFileSync(scriptPath, `
console.log(JSON.stringify({
  type: "thread.started",
  thread_id: "019d5078-d4b8-7f72-b81f-f4ca1b0b512f"
}));
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    id: "item_1",
    type: "agent_message",
    text: "Managed session started."
  }
}));
`, "utf8");

  const adapter = new CodexCliAdapter({
    binPath: process.execPath,
    binArgs: [scriptPath],
    codexHome: resolve(root, ".codex"),
  });

  const patches: Record<string, unknown>[] = [];
  await adapter.runTask(createTask(projectRoot), createSession(projectRoot), {
    onEvent: () => {},
    onSessionPatch: (patch) => {
      patches.push(patch);
    },
    onTerminalData: () => {},
  });

  assert.ok(patches.some((patch) => patch.codex_session_id === "019d5078-d4b8-7f72-b81f-f4ca1b0b512f"));

  rmSync(root, { recursive: true, force: true });
});

test("codex adapter can append a short relay update into an existing conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-codex-"));
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const argvFile = resolve(root, "argv.json");
  const scriptPath = resolve(root, "fake-codex-relay.mjs");

  writeFileSync(scriptPath, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ASYNQ_AGENTD_ARGV_FILE, JSON.stringify(process.argv.slice(2), null, 2));
`, "utf8");

  const adapter = new CodexCliAdapter({
    binPath: process.execPath,
    binArgs: [scriptPath],
    codexHome: resolve(root, ".codex"),
    env: {
      ASYNQ_AGENTD_ARGV_FILE: argvFile,
    },
  });

  await adapter.appendToConversation(
    "019cda49-9e87-7a13-a4e8-7dddb62a9d99",
    "Buddy managed handoff update",
    {
      projectPath: projectRoot,
      modelPreference: "gpt-5.4",
    },
  );

  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.deepEqual(argv.slice(0, 7), [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "-m",
    "gpt-5.4",
    "019cda49-9e87-7a13-a4e8-7dddb62a9d99",
  ]);
  assert.equal(argv[7], "Buddy managed handoff update");

  rmSync(root, { recursive: true, force: true });
});

test("codex adapter accepts live terminal input", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-codex-"));
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const scriptPath = resolve(root, "fake-codex-stdin.mjs");

  writeFileSync(scriptPath, `
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

console.log(JSON.stringify({
  type: "session_meta",
  payload: {
    id: "019cda49-9e87-7a13-a4e8-7dddb62a9d99",
    cwd: process.cwd(),
    cli_version: "0.108.0-alpha.12"
  }
}));

rl.on("line", (line) => {
  console.log(JSON.stringify({
    type: "event_msg",
    payload: {
      type: "agent_message",
      message: "stdin:" + line
    }
  }));
  rl.close();
  process.exit(0);
});
`, "utf8");

  const adapter = new CodexCliAdapter({
    binPath: process.execPath,
    binArgs: [scriptPath],
    codexHome: resolve(root, ".codex"),
  });

  const session = createSession(projectRoot);
  const terminalChunks: string[] = [];
  const runPromise = adapter.runTask(createTask(projectRoot), session, {
    onEvent: () => {},
    onSessionPatch: () => {},
    onTerminalData: (_stream, chunk) => {
      terminalChunks.push(chunk);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  adapter.writeTerminalInput?.(session.id, "hello from terminal\n");
  await runPromise;

  assert.ok(terminalChunks.some((chunk) => chunk.includes("stdin:hello from terminal")));

  rmSync(root, { recursive: true, force: true });
});
