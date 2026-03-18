import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalSpawnPlan } from "./terminal-spawn.ts";

test("createTerminalSpawnPlan falls back to direct pipe mode when PTY is disabled", () => {
  const previous = process.env.ASYNQ_AGENTD_TERMINAL_MODE;
  process.env.ASYNQ_AGENTD_TERMINAL_MODE = "pipe";

  const plan = createTerminalSpawnPlan("claude", ["-p", "hello"]);
  assert.equal(plan.command, "claude");
  assert.deepEqual(plan.args, ["-p", "hello"]);
  assert.equal(plan.mode, "pipe");
  assert.equal(plan.transport, "direct");

  if (previous === undefined) {
    delete process.env.ASYNQ_AGENTD_TERMINAL_MODE;
  } else {
    process.env.ASYNQ_AGENTD_TERMINAL_MODE = previous;
  }
});

test("createTerminalSpawnPlan can choose script-backed PTY mode on macOS", () => {
  const previous = process.env.ASYNQ_AGENTD_TERMINAL_MODE;
  process.env.ASYNQ_AGENTD_TERMINAL_MODE = "pty";

  const plan = createTerminalSpawnPlan("codex", ["exec", "--json"]);
  if (process.platform === "darwin" && process.stdin.isTTY) {
    assert.equal(plan.command, "/usr/bin/script");
    assert.deepEqual(plan.args, ["-q", "/dev/null", "codex", "exec", "--json"]);
    assert.equal(plan.mode, "pty");
    assert.equal(plan.transport, "script");
  } else {
    assert.equal(plan.command, "codex");
    assert.equal(plan.mode, "pipe");
    assert.equal(plan.transport, "direct");
  }

  if (previous === undefined) {
    delete process.env.ASYNQ_AGENTD_TERMINAL_MODE;
  } else {
    process.env.ASYNQ_AGENTD_TERMINAL_MODE = previous;
  }
});
