import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentAdapter, AdapterHooks, AppendConversationResult } from "./agent-adapter.ts";
import type { ActivityPayload, SessionRecord, TaskRecord } from "../domain.ts";
import { parseJsonSafe } from "../utils/json.ts";
import { createTerminalSpawnPlan } from "../utils/terminal-spawn.ts";

interface ClaudeCliAdapterOptions {
  binPath?: string;
  binArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class ClaudeCliAdapter implements AgentAdapter {
  readonly name = "claude-cli";

  private readonly binPath: string;
  private readonly binArgs: string[];
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly stopRequested = new Set<string>();

  constructor(options: ClaudeCliAdapterOptions = {}) {
    this.binPath = options.binPath
      ?? process.env.ASYNQ_AGENTD_CLAUDE_BIN
      ?? (existsSync(`${process.env.HOME ?? ""}/.local/bin/claude`) ? `${process.env.HOME ?? ""}/.local/bin/claude` : "claude");
    this.binArgs = options.binArgs ?? [];
    this.env = options.env;
  }

  async runTask(task: TaskRecord, session: SessionRecord, hooks: AdapterHooks): Promise<void> {
    const prompt = this.buildPrompt(task, session);
    const resumeSessionId = this.pickResumeSessionId(task, session);
    const args = [
      ...this.binArgs,
      ...this.buildClaudeArgs(task, prompt, resumeSessionId, session),
    ];
    const spawnPlan = createTerminalSpawnPlan(this.binPath, args);

    hooks.onSessionPatch({
      claude_command: [this.binPath, ...args].join(" "),
      claude_spawn_command: [spawnPlan.command, ...spawnPlan.args].join(" "),
      claude_resume_session_id: resumeSessionId,
      claude_run_mode: resumeSessionId ? "resume" : "print",
      terminal_mode: spawnPlan.mode,
      terminal_transport: spawnPlan.transport,
    });

    await new Promise<void>((resolve, reject) => {
      const child = spawn(spawnPlan.command, spawnPlan.args, {
        cwd: task.project_path,
        env: {
          ...process.env,
          ...this.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.processes.set(session.id, child);
      hooks.onSessionPatch({
        adapter_pid: child.pid ?? null,
      });

      let stdoutBuffer = "";
      const stderrChunks: string[] = [];

      const flushStdout = (chunk: string, final = false) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        if (!final) {
          stdoutBuffer = lines.pop() ?? "";
        } else {
          stdoutBuffer = "";
        }

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          const entry = parseJsonSafe<Record<string, unknown> | undefined>(trimmed, undefined);
          if (!entry) {
            continue;
          }

          const metadataPatch = this.extractSessionPatch(entry);
          if (metadataPatch) {
            hooks.onSessionPatch(metadataPatch);
          }

          for (const payload of this.mapEntryToActivity(entry)) {
            hooks.onEvent(payload);
          }
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        hooks.onTerminalData("stdout", chunk);
        flushStdout(chunk, false);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        hooks.onTerminalData("stderr", chunk);
        stderrChunks.push(chunk);
      });

      child.on("error", (error) => {
        this.processes.delete(session.id);
        this.stopRequested.delete(session.id);
        reject(error);
      });

      child.on("close", (code, signal) => {
        flushStdout("", true);
        this.processes.delete(session.id);
        const requestedStop = this.stopRequested.delete(session.id);
        const stderrText = stderrChunks.join("").trim();
        hooks.onSessionPatch({
          adapter_pid: null,
          last_exit_code: code ?? null,
          last_exit_signal: signal ?? null,
          last_stderr: stderrText || undefined,
        });

        if (requestedStop) {
          resolve();
          return;
        }

        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderrText || `Claude exited with code ${code ?? "unknown"}`));
      });
    });
  }

  stopSession(sessionId: string): void {
    const child = this.processes.get(sessionId);
    if (!child) {
      return;
    }

    this.stopRequested.add(sessionId);
    child.kill("SIGTERM");
  }

  async appendToConversation(
    conversationId: string,
    prompt: string,
    options?: {
      projectPath?: string;
      modelPreference?: string;
    },
  ): Promise<AppendConversationResult> {
    const args = [
      ...this.binArgs,
      ...this.buildClaudeAppendArgs(conversationId, prompt, options?.projectPath, options?.modelPreference),
    ];
    const spawnPlan = createTerminalSpawnPlan(this.binPath, args);

    return await new Promise<AppendConversationResult>((resolve, reject) => {
      const child = spawn(spawnPlan.command, spawnPlan.args, {
        cwd: options?.projectPath ?? process.cwd(),
        env: {
          ...process.env,
          ...this.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end();

      const stderrChunks: string[] = [];
      let stdoutBuffer = "";
      let lastMessage: string | undefined;

      const flushStdout = (chunk: string, final = false) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        if (!final) {
          stdoutBuffer = lines.pop() ?? "";
        } else {
          stdoutBuffer = "";
        }

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          const entry = parseJsonSafe<Record<string, unknown> | undefined>(trimmed, undefined);
          if (entry?.type === "assistant" && typeof entry.message === "object" && entry.message) {
            const text = this.extractAssistantText(entry.message as Record<string, unknown>);
            if (text) {
              lastMessage = text;
            }
          }

          if (entry?.type === "result") {
            lastMessage = this.pickString(entry.result) ?? lastMessage;
          }
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        flushStdout(chunk, false);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
      });

      child.on("error", reject);
      child.on("close", (code) => {
        flushStdout("", true);
        if (code === 0) {
          resolve({ lastMessage });
          return;
        }

        reject(new Error(stderrChunks.join("").trim() || `Claude relay exited with code ${code ?? "unknown"}`));
      });
    });
  }

  canResumeTask(task: TaskRecord, session: SessionRecord): boolean {
    return Boolean(this.pickResumeSessionId(task, session));
  }

  writeTerminalInput(sessionId: string, input: string): void {
    const child = this.processes.get(sessionId);
    if (!child?.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error(`Claude session ${sessionId} is not accepting terminal input`);
    }

    child.stdin.write(input);
  }

  private buildClaudeArgs(
    task: TaskRecord,
    prompt: string,
    resumeSessionId: string | undefined,
    session: SessionRecord,
  ): string[] {
    const model = task.model_preference?.trim();
    const base = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "acceptEdits",
      ...(model ? ["--model", model] : []),
      "--add-dir",
      task.project_path,
    ];

    if (resumeSessionId) {
      return [
        ...base,
        "--resume",
        resumeSessionId,
        ...(this.pickString(session.metadata?.claude_session_id) ? [] : ["--session-id", resumeSessionId]),
        prompt,
      ];
    }

    return [
      ...base,
      prompt,
    ];
  }

  private buildClaudeAppendArgs(
    conversationId: string,
    prompt: string,
    projectPath?: string,
    model?: string,
  ): string[] {
    return [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "acceptEdits",
      ...(model?.trim() ? ["--model", model.trim()] : []),
      ...(projectPath?.trim() ? ["--add-dir", projectPath.trim()] : []),
      "--resume",
      conversationId,
      prompt,
    ];
  }

  private buildPrompt(task: TaskRecord, session: SessionRecord): string {
    const lines = [
      `Task: ${task.title}`,
      task.description.trim(),
    ];

    if (task.context?.files_to_focus?.length) {
      lines.push(`Focus files: ${task.context.files_to_focus.join(", ")}`);
    }

    if (task.context?.test_command) {
      lines.push(`Validation command: ${task.context.test_command}`);
    }

    if (task.context?.recurring_history?.length) {
      lines.push([
        "Recurring task history (compact, newest last):",
        ...task.context.recurring_history.map((item) => `- ${item.run_at} ${item.status}: ${item.summary}`),
        "Use this history to avoid duplicate work and to continue the recurring task coherently.",
      ].join("\n"));
    }

    const queuedMessages = Array.isArray(session.metadata?.queued_operator_messages)
      ? session.metadata?.queued_operator_messages as Array<Record<string, unknown>>
      : [];
    if (queuedMessages.length > 0) {
      const additions = queuedMessages
        .map((item) => this.pickString(item.message))
        .filter((value): value is string => Boolean(value));
      if (additions.length > 0) {
        lines.push(`Operator follow-up: ${additions.join("\n")}`);
      }
    }

    return lines.join("\n\n");
  }

  private pickResumeSessionId(task: TaskRecord, session: SessionRecord): string | undefined {
    const stored = this.pickString(session.metadata?.claude_session_id);
    if (stored) {
      return stored;
    }

    if (task.context?.previous_session_id && this.isUuid(task.context.previous_session_id)) {
      return task.context.previous_session_id;
    }

    return undefined;
  }

  private extractSessionPatch(entry: Record<string, unknown>): Record<string, unknown> | undefined {
    if (entry.type === "system" && entry.subtype === "init") {
      return {
        claude_session_id: this.pickString(entry.session_id),
        claude_model: this.pickString(entry.model),
        claude_permission_mode: this.pickString(entry.permissionMode),
        claude_version: this.pickString(entry.claude_code_version),
        claude_cwd: this.pickString(entry.cwd),
      };
    }

    if (entry.type === "result") {
      return {
        claude_session_id: this.pickString(entry.session_id),
        claude_total_cost_usd: typeof entry.total_cost_usd === "number" ? entry.total_cost_usd : undefined,
        claude_result_error: entry.is_error === true,
      };
    }

    if (entry.type === "assistant") {
      return {
        claude_session_id: this.pickString(entry.session_id),
      };
    }

    return undefined;
  }

  private mapEntryToActivity(entry: Record<string, unknown>): ActivityPayload[] {
    if (entry.type === "system" && entry.subtype === "init") {
      return [{
        type: "session_state_change",
        from: "unknown",
        to: "working",
      }];
    }

    if (entry.type === "assistant" && typeof entry.message === "object" && entry.message) {
      const message = entry.message as Record<string, unknown>;
      const text = this.extractAssistantText(message);
      const events: ActivityPayload[] = [];
      if (text) {
        events.push({
          type: "agent_thinking",
          summary: text,
        });
      }

      events.push(...this.extractToolUseIntents(message));

      const usage = typeof message.usage === "object" && message.usage ? message.usage as Record<string, unknown> : undefined;
      if (usage) {
        const inputTokens = Number(usage.input_tokens ?? 0);
        const outputTokens = Number(usage.output_tokens ?? 0);
        const model = this.pickString(message.model) ?? "unknown";
        if (inputTokens > 0 || outputTokens > 0) {
          events.push({
            type: "model_call",
            model,
            tokens_in: inputTokens,
            tokens_out: outputTokens,
            cost_usd: 0,
          });
        }
      }

      if (entry.error === "authentication_failed") {
        events.push({
          type: "error",
          message: text ?? "Claude authentication failed",
          recoverable: true,
        });
      }

      return events;
    }

    if (entry.type === "result") {
      const events: ActivityPayload[] = [];
      const usage = typeof entry.usage === "object" && entry.usage ? entry.usage as Record<string, unknown> : undefined;
      const modelUsage = typeof entry.modelUsage === "object" && entry.modelUsage ? entry.modelUsage as Record<string, unknown> : undefined;
      const totalCost = typeof entry.total_cost_usd === "number" ? entry.total_cost_usd : 0;
      const inputTokens = Number(usage?.input_tokens ?? 0);
      const outputTokens = Number(usage?.output_tokens ?? 0);
      const model = this.pickString(...Object.keys(modelUsage ?? {}), entry.model) ?? "unknown";
      if (inputTokens > 0 || outputTokens > 0 || totalCost > 0) {
        events.push({
          type: "model_call",
          model,
          tokens_in: inputTokens,
          tokens_out: outputTokens,
          cost_usd: totalCost,
        });
      }

      if (entry.is_error === true) {
        events.push({
          type: "error",
          message: this.pickString(entry.result) ?? "Claude task failed",
          recoverable: true,
        });
      }

      return events;
    }

    return [];
  }

  private extractAssistantText(message: Record<string, unknown>): string | undefined {
    if (!Array.isArray(message.content)) {
      return undefined;
    }

    const text = message.content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return undefined;
        }

        const contentItem = item as Record<string, unknown>;
        return this.pickString(contentItem.text);
      })
      .filter((value): value is string => Boolean(value))
      .join("\n");

    return text || undefined;
  }

  private extractToolUseIntents(message: Record<string, unknown>): ActivityPayload[] {
    if (!Array.isArray(message.content)) {
      return [];
    }

    const events: ActivityPayload[] = [];
    for (const item of message.content) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const contentItem = item as Record<string, unknown>;
      if (contentItem.type !== "tool_use") {
        continue;
      }

      const toolName = this.pickString(contentItem.name);
      const input = typeof contentItem.input === "object" && contentItem.input ? contentItem.input as Record<string, unknown> : undefined;
      if (!toolName || !input) {
        continue;
      }

      const commandIntent = this.extractClaudeCommandIntent(toolName, input);
      if (commandIntent) {
        events.push(commandIntent);
      }

      const fileIntent = this.extractClaudeFileIntent(toolName, input);
      if (fileIntent) {
        events.push(fileIntent);
      }
    }

    return events;
  }

  private extractClaudeCommandIntent(toolName: string, input: Record<string, unknown>): ActivityPayload | undefined {
    if (toolName !== "Bash") {
      return undefined;
    }

    const command = this.pickString(input.command);
    if (!command) {
      return undefined;
    }

    return {
      type: "command_intent",
      cmd: command,
      source: "tool_call",
    };
  }

  private extractClaudeFileIntent(toolName: string, input: Record<string, unknown>): ActivityPayload | undefined {
    const filePath = this.pickString(input.file_path, input.path);
    if (!filePath) {
      return undefined;
    }

    if (toolName === "Edit") {
      return {
        type: "file_batch_intent",
        summary: "Claude is about to edit 1 file.",
        files: [{
          path: filePath,
          action: "edited",
          lines_added: this.countLines(this.pickString(input.new_string)),
          lines_removed: this.countLines(this.pickString(input.old_string)),
        }],
      };
    }

    if (toolName === "Write") {
      return {
        type: "file_batch_intent",
        summary: "Claude is about to write 1 file.",
        files: [{
          path: filePath,
          action: "edited",
          lines_added: this.countLines(this.pickString(input.content)),
          lines_removed: 0,
        }],
      };
    }

    return undefined;
  }

  private pickString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    return undefined;
  }

  private countLines(value: string | undefined): number {
    if (!value) {
      return 0;
    }

    return value.split("\n").length;
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }
}
