import { setTimeout as delay } from "node:timers/promises";
import type { AgentAdapter } from "./agent-adapter.ts";
import type { SessionRecord, TaskRecord } from "../domain.ts";
import type { AdapterHooks } from "./agent-adapter.ts";

export class MockAgentAdapter implements AgentAdapter {
  readonly name = "mock";

  async runTask(task: TaskRecord, _session: SessionRecord, hooks: AdapterHooks): Promise<void> {
    hooks.onTerminalData("stdout", `Mock adapter starting task ${task.title}\n`);
    hooks.onEvent({
      type: "agent_thinking",
      summary: `Preparing task "${task.title}" for ${task.project_path}`,
    });
    await delay(25);

    hooks.onEvent({
      type: "command_run",
      cmd: task.context?.test_command ?? "echo \"planning work\"",
      exit_code: 0,
      duration_ms: 25,
      stdout_preview: "Mock adapter executed a bootstrap command",
    });
    await delay(25);

    hooks.onEvent({
      type: "file_edit",
      path: `${task.project_path}/README.md`,
      lines_added: 8,
      lines_removed: 0,
    });
    await delay(25);

    hooks.onEvent({
      type: "model_call",
      model: task.model_preference ?? "claude-sonnet",
      tokens_in: 512,
      tokens_out: 1024,
      cost_usd: 0.08,
    });
    await delay(25);

    hooks.onEvent({
      type: "test_run",
      passed: 1,
      failed: 0,
      skipped: 0,
      duration_ms: 12,
    });
  }
}
