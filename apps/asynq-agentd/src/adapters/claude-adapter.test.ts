import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCliAdapter } from "./claude-adapter.ts";
import type { ActivityPayload, SessionRecord, TaskRecord } from "../domain.ts";

function createTask(projectPath: string, previousSessionId?: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "task_claude",
    title: "Implement Claude adapter",
    description: "Run Claude Code in stream-json mode.",
    agent_type: "claude-code",
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
    id: "sess_claude",
    title: "Implement Claude adapter",
    agent_type: "claude-code",
    project_path: projectPath,
    state: "working",
    adapter: "claude-cli",
    created_at: now,
    updated_at: now,
    metadata: {},
  };
}

test("claude adapter streams stream-json events and stores session metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-claude-"));
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const argvFile = resolve(root, "argv.json");
  const scriptPath = resolve(root, "fake-claude.mjs");

  writeFileSync(scriptPath, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ASYNQ_AGENTD_ARGV_FILE, JSON.stringify(process.argv.slice(2), null, 2));
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  session_id: "bf42dbce-d5d7-40a2-97b7-fa60e12b9d76",
  model: "claude-sonnet-4-6",
  permissionMode: "acceptEdits",
  claude_code_version: "2.1.76"
}));
console.log(JSON.stringify({
  type: "assistant",
  session_id: "bf42dbce-d5d7-40a2-97b7-fa60e12b9d76",
  message: {
    model: "claude-sonnet-4-6",
    usage: {
      input_tokens: 120,
      output_tokens: 40
    },
    content: [
      { type: "text", text: "I am starting the requested work." },
      {
        type: "tool_use",
        id: "toolu_demo_bash",
        name: "Bash",
        input: {
          command: "git push origin main",
          description: "Push the branch"
        }
      },
      {
        type: "tool_use",
        id: "toolu_demo_edit",
        name: "Edit",
        input: {
          file_path: "/tmp/example.ts",
          old_string: "before\\n",
          new_string: "after\\n"
        }
      }
    ]
  }
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "bf42dbce-d5d7-40a2-97b7-fa60e12b9d76",
  result: "Done",
  total_cost_usd: 0.12,
  usage: {
    input_tokens: 120,
    output_tokens: 40
  },
  modelUsage: {
    "claude-sonnet-4-6": {
      input_tokens: 120,
      output_tokens: 40
    }
  }
}));
`, "utf8");

  const adapter = new ClaudeCliAdapter({
    binPath: process.execPath,
    binArgs: [scriptPath],
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
  assert.ok(argv.includes("-p"));
  assert.ok(argv.includes("--output-format"));
  assert.ok(argv.includes("stream-json"));
  assert.ok(events.some((payload) => payload.type === "session_state_change"));
  assert.ok(events.some((payload) => payload.type === "agent_thinking" && payload.summary.includes("starting")));
  assert.ok(events.some((payload) => payload.type === "command_intent" && payload.cmd === "git push origin main"));
  assert.ok(events.some((payload) => payload.type === "file_batch_intent" && payload.files[0]?.path === "/tmp/example.ts"));
  assert.ok(events.some((payload) => payload.type === "model_call" && payload.cost_usd === 0.12));
  assert.ok(patches.some((patch) => patch.claude_session_id === "bf42dbce-d5d7-40a2-97b7-fa60e12b9d76"));

  rmSync(root, { recursive: true, force: true });
});

test("claude adapter resumes from previous session id when provided", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-claude-"));
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const argvFile = resolve(root, "argv.json");
  const scriptPath = resolve(root, "fake-claude.mjs");

  writeFileSync(scriptPath, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ASYNQ_AGENTD_ARGV_FILE, JSON.stringify(process.argv.slice(2), null, 2));
`, "utf8");

  const adapter = new ClaudeCliAdapter({
    binPath: process.execPath,
    binArgs: [scriptPath],
    env: {
      ASYNQ_AGENTD_ARGV_FILE: argvFile,
    },
  });

  await adapter.runTask(
    createTask(projectRoot, "bf42dbce-d5d7-40a2-97b7-fa60e12b9d76"),
    createSession(projectRoot),
    {
      onEvent: () => {},
      onSessionPatch: () => {},
      onTerminalData: () => {},
    },
  );

  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.ok(argv.includes("--resume"));
  assert.ok(argv.includes("bf42dbce-d5d7-40a2-97b7-fa60e12b9d76"));

  rmSync(root, { recursive: true, force: true });
});

test("claude adapter appends to an existing conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-claude-"));
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const argvFile = resolve(root, "argv.json");
  const scriptPath = resolve(root, "fake-claude-append.mjs");

  writeFileSync(scriptPath, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ASYNQ_AGENTD_ARGV_FILE, JSON.stringify(process.argv.slice(2), null, 2));
console.log(JSON.stringify({
  type: "assistant",
  session_id: "bf42dbce-d5d7-40a2-97b7-fa60e12b9d76",
  message: {
    content: [
      { type: "text", text: "HOTOVO: Claude continuation completed." }
    ]
  }
}));
`, "utf8");

  const adapter = new ClaudeCliAdapter({
    binPath: process.execPath,
    binArgs: [scriptPath],
    env: {
      ASYNQ_AGENTD_ARGV_FILE: argvFile,
    },
  });

  const result = await adapter.appendToConversation(
    "bf42dbce-d5d7-40a2-97b7-fa60e12b9d76",
    "Buddy review decision",
    {
      projectPath: projectRoot,
      modelPreference: "claude-sonnet-4-6",
    },
  );

  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.ok(argv.includes("-p"));
  assert.ok(argv.includes("--output-format"));
  assert.ok(argv.includes("stream-json"));
  assert.ok(argv.includes("--resume"));
  assert.ok(argv.includes("bf42dbce-d5d7-40a2-97b7-fa60e12b9d76"));
  assert.ok(argv.includes("--add-dir"));
  assert.ok(argv.includes(projectRoot));
  assert.ok(argv.includes("--model"));
  assert.ok(argv.includes("claude-sonnet-4-6"));
  assert.equal(argv.at(-1), "Buddy review decision");
  assert.equal(result.lastMessage, "HOTOVO: Claude continuation completed.");

  rmSync(root, { recursive: true, force: true });
});

test("claude adapter accepts live terminal input", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-claude-"));
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const scriptPath = resolve(root, "fake-claude-stdin.mjs");

  writeFileSync(scriptPath, `
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  session_id: "bf42dbce-d5d7-40a2-97b7-fa60e12b9d76",
  model: "claude-sonnet-4-6",
  permissionMode: "acceptEdits",
  claude_code_version: "2.1.76"
}));

rl.on("line", (line) => {
  console.log(JSON.stringify({
    type: "assistant",
    session_id: "bf42dbce-d5d7-40a2-97b7-fa60e12b9d76",
    message: {
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "stdin:" + line }
      ]
    }
  }));
  rl.close();
  process.exit(0);
});
`, "utf8");

  const adapter = new ClaudeCliAdapter({
    binPath: process.execPath,
    binArgs: [scriptPath],
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
