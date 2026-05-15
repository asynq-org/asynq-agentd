import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentAdapter, AdapterHooks, AppendConversationResult } from "./agent-adapter.ts";
import type { ActivityPayload, SessionRecord, TaskRecord } from "../domain.ts";
import { parseJsonSafe } from "../utils/json.ts";
import { createTerminalSpawnPlan } from "../utils/terminal-spawn.ts";

interface CursorCliAdapterOptions {
  binPath?: string;
  binArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

interface PendingCursorToolCall {
  cmd: string;
  sideEffects: ActivityPayload[];
}

export class CursorCliAdapter implements AgentAdapter {
  readonly name = "cursor-cli";

  private readonly binPath: string;
  private readonly binArgs: string[];
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly stopRequested = new Set<string>();

  constructor(options: CursorCliAdapterOptions = {}) {
    this.binPath = options.binPath
      ?? process.env.ASYNQ_AGENTD_CURSOR_BIN
      ?? process.env.CURSOR_BIN
      ?? "cursor-agent";
    this.binArgs = options.binArgs ?? [];
    this.env = options.env;
  }

  async runTask(task: TaskRecord, session: SessionRecord, hooks: AdapterHooks): Promise<void> {
    const prompt = this.buildPrompt(task, session);
    const resumeSessionId = this.pickResumeSessionId(task, session);
    const args = [
      ...this.binArgs,
      ...this.buildCursorArgs(task, prompt, resumeSessionId),
    ];
    const spawnPlan = createTerminalSpawnPlan(this.binPath, args);

    hooks.onSessionPatch({
      cursor_command: [this.binPath, ...args].join(" "),
      cursor_spawn_command: [spawnPlan.command, ...spawnPlan.args].join(" "),
      cursor_resume_session_id: resumeSessionId,
      cursor_run_mode: resumeSessionId ? "resume" : "print",
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
      child.stdin.end();

      this.processes.set(session.id, child);
      hooks.onSessionPatch({
        adapter_pid: child.pid ?? null,
      });

      const pendingToolCalls = new Map<string, PendingCursorToolCall>();
      const stderrChunks: string[] = [];
      let stdoutBuffer = "";

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

          for (const payload of this.mapEntryToActivity(entry, pendingToolCalls)) {
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

        if (requestedStop || code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderrText || `Cursor exited with code ${code ?? "unknown"}`));
      });
    });
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
      ...this.buildCursorPrintArgs(prompt, conversationId, options?.modelPreference),
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
          lastMessage = this.extractAssistantText(entry) ?? lastMessage;
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

        reject(new Error(stderrChunks.join("").trim() || `Cursor relay exited with code ${code ?? "unknown"}`));
      });
    });
  }

  canResumeTask(task: TaskRecord, session: SessionRecord): boolean {
    return Boolean(this.pickResumeSessionId(task, session));
  }

  stopSession(sessionId: string): void {
    const child = this.processes.get(sessionId);
    if (!child) {
      return;
    }

    this.stopRequested.add(sessionId);
    child.kill("SIGTERM");
  }

  writeTerminalInput(sessionId: string, input: string): void {
    const child = this.processes.get(sessionId);
    if (!child?.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error(`Cursor session ${sessionId} is not accepting terminal input`);
    }

    child.stdin.write(input);
  }

  private buildCursorArgs(task: TaskRecord, prompt: string, resumeSessionId?: string): string[] {
    return this.buildCursorPrintArgs(prompt, resumeSessionId, task.model_preference);
  }

  private buildCursorPrintArgs(prompt: string, resumeSessionId?: string, model?: string): string[] {
    return [
      "-p",
      "--force",
      "--output-format",
      "stream-json",
      ...(model?.trim() ? ["--model", model.trim()] : []),
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
      prompt,
    ];
  }

  private pickResumeSessionId(task: TaskRecord, session: SessionRecord): string | undefined {
    return this.pickString(
      session.metadata?.cursor_session_id,
      session.metadata?.cursor_resume_session_id,
      task.context?.previous_session_id,
      task.context?.source_cursor_session_id,
    );
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

    if (task.context?.observed_takeover) {
      const takeover = task.context.observed_takeover;
      lines.push([
        "Observed takeover contract:",
        `- Action: ${takeover.action}`,
        `- Context: ${takeover.context}`,
        takeover.cmd ? `- Blocked command: ${takeover.cmd}` : undefined,
        takeover.success_checks?.length
          ? `- Success checks:\n${takeover.success_checks.map((check) =>
            check.kind === "path_exists"
              ? `  - path_exists ${check.path_type ?? "any"} ${check.path ?? "(missing path)"}`
              : `  - command_exit_zero ${check.cmd ?? "(missing command)"}`).join("\n")}`
          : undefined,
        "- Actually perform the blocked work instead of only inspecting earlier logs.",
        "- If Buddy approval is needed for the blocked command, request it before claiming success.",
        "- Do not declare success unless the success checks are truly satisfied in this takeover.",
      ].filter(Boolean).join("\n"));
    }

    const queuedMessages = Array.isArray(session.metadata?.queued_operator_messages)
      ? session.metadata?.queued_operator_messages as Array<Record<string, unknown>>
      : [];
    const additions = queuedMessages
      .map((item) => this.pickString(item.message))
      .filter((value): value is string => Boolean(value));
    if (additions.length > 0) {
      lines.push(`Operator follow-up: ${additions.join("\n")}`);
    }

    return lines.join("\n\n");
  }

  private extractSessionPatch(entry: Record<string, unknown>): Record<string, unknown> | undefined {
    if (entry.type !== "system" && entry.type !== "result") {
      return undefined;
    }

    return {
      cursor_session_id: this.pickString(entry.session_id, entry.chat_id, entry.conversation_id),
      cursor_model: this.pickString(entry.model),
      cursor_duration_ms: typeof entry.duration_ms === "number" ? entry.duration_ms : undefined,
    };
  }

  private mapEntryToActivity(
    entry: Record<string, unknown>,
    pendingToolCalls: Map<string, PendingCursorToolCall>,
  ): ActivityPayload[] {
    const type = this.pickString(entry.type);
    const subtype = this.pickString(entry.subtype);

    if (type === "system" && subtype === "init") {
      return [{
        type: "session_state_change",
        from: "unknown",
        to: "idle",
      }];
    }

    if (type === "assistant") {
      const text = this.extractAssistantText(entry);
      return text ? [{ type: "agent_thinking", summary: text }] : [];
    }

    if (type === "result") {
      const text = this.extractAssistantText(entry);
      const payloads: ActivityPayload[] = text ? [{ type: "agent_output", message: text }] : [];
      const model = this.pickString(entry.model);
      if (model) {
        payloads.push({
          type: "model_call",
          model,
          tokens_in: Number(entry.input_tokens ?? entry.tokens_in ?? 0),
          tokens_out: Number(entry.output_tokens ?? entry.tokens_out ?? 0),
          cost_usd: Number(entry.cost_usd ?? 0),
        });
      }
      payloads.push({
        type: "session_state_change",
        from: "working",
        to: "completed",
      });
      return payloads;
    }

    if (type === "tool_call" && subtype === "started") {
      const tool = this.extractToolCall(entry);
      if (!tool) {
        return [];
      }

      const command = this.describeToolCall(tool);
      const sideEffects = this.extractToolSideEffects(tool);
      const id = this.pickString(entry.tool_call_id, tool.id, tool.call_id);
      if (id) {
        pendingToolCalls.set(id, { cmd: command, sideEffects });
      }

      const intent = this.extractToolIntent(tool);
      return intent ? [intent] : [];
    }

    if (type === "tool_call" && subtype === "completed") {
      const tool = this.extractToolCall(entry);
      const id = this.pickString(entry.tool_call_id, tool?.id, tool?.call_id);
      const pending = id ? pendingToolCalls.get(id) : undefined;
      if (id) {
        pendingToolCalls.delete(id);
      }
      const command = pending?.cmd ?? (tool ? this.describeToolCall(tool) : "tool:unknown");
      const durationMs = Number(entry.duration_ms ?? tool?.duration_ms ?? 0);
      return [
        {
          type: "command_run",
          cmd: command,
          exit_code: this.extractToolExitCode(tool),
          duration_ms: Number.isFinite(durationMs) ? durationMs : 0,
          stdout_preview: tool ? this.extractToolResult(tool) : undefined,
        },
        ...(pending?.sideEffects ?? []),
      ];
    }

    return [];
  }

  private extractAssistantText(entry: Record<string, unknown> | undefined): string | undefined {
    if (!entry) {
      return undefined;
    }

    const direct = this.pickString(entry.result, entry.text, typeof entry.message === "string" ? entry.message : undefined);
    if (direct) {
      return direct;
    }

    if (typeof entry.message === "object" && entry.message) {
      const message = entry.message as Record<string, unknown>;
      const messageText = this.pickString(message.text, typeof message.content === "string" ? message.content : undefined);
      if (messageText) {
        return messageText;
      }

      if (Array.isArray(message.content)) {
        const parts = message.content
          .map((part) => {
            if (!part || typeof part !== "object") {
              return undefined;
            }
            return this.pickString((part as Record<string, unknown>).text);
          })
          .filter((value): value is string => Boolean(value));
        return parts.length > 0 ? parts.join("\n") : undefined;
      }
    }

    return undefined;
  }

  private extractToolCall(entry: Record<string, unknown>): Record<string, unknown> | undefined {
    return typeof entry.tool_call === "object" && entry.tool_call
      ? entry.tool_call as Record<string, unknown>
      : undefined;
  }

  private describeToolCall(tool: Record<string, unknown>): string {
    const shellCall = this.pickNestedObject(tool, "shellToolCall", "bashToolCall", "terminalToolCall", "runCommandToolCall");
    const shellArgs = shellCall ? this.pickObject(shellCall.args) : undefined;
    const command = this.pickString(shellArgs?.command, shellArgs?.cmd, shellCall?.command, shellCall?.cmd);
    if (command) {
      return command;
    }

    const readCall = this.pickNestedObject(tool, "readToolCall");
    const writeCall = this.pickNestedObject(tool, "writeToolCall", "editToolCall");
    const deleteCall = this.pickNestedObject(tool, "deleteToolCall");
    if (writeCall) {
      return `tool:write ${this.pickString(this.pickObject(writeCall.args)?.path, writeCall.path) ?? ""}`.trim();
    }
    if (deleteCall) {
      return `tool:delete ${this.pickString(this.pickObject(deleteCall.args)?.path, deleteCall.path) ?? ""}`.trim();
    }
    if (readCall) {
      return `tool:read ${this.pickString(this.pickObject(readCall.args)?.path, readCall.path) ?? ""}`.trim();
    }

    return `tool:${this.pickString(tool.name, tool.type) ?? "unknown"}`;
  }

  private extractToolIntent(tool: Record<string, unknown>): ActivityPayload | undefined {
    const shellCall = this.pickNestedObject(tool, "shellToolCall", "bashToolCall", "terminalToolCall", "runCommandToolCall");
    const shellArgs = shellCall ? this.pickObject(shellCall.args) : undefined;
    const command = this.pickString(shellArgs?.command, shellArgs?.cmd, shellCall?.command, shellCall?.cmd);
    if (command) {
      return { type: "command_intent", cmd: command, source: "tool_call" };
    }

    const writeCall = this.pickNestedObject(tool, "writeToolCall", "editToolCall");
    const deleteCall = this.pickNestedObject(tool, "deleteToolCall");
    const writeArgs = writeCall ? this.pickObject(writeCall.args) : undefined;
    const deleteArgs = deleteCall ? this.pickObject(deleteCall.args) : undefined;
    const writePath = this.pickString(writeArgs?.path, writeArgs?.file_path, writeCall?.path, writeCall?.file_path);
    const deletePath = this.pickString(deleteArgs?.path, deleteArgs?.file_path, deleteCall?.path, deleteCall?.file_path);
    if (deletePath) {
      return { type: "file_delete", path: deletePath };
    }
    if (writePath) {
      return {
        type: "file_edit",
        path: writePath,
        lines_added: Number(writeArgs?.linesCreated ?? writeArgs?.lines_added ?? 0),
        lines_removed: Number(writeArgs?.linesRemoved ?? writeArgs?.lines_removed ?? 0),
      };
    }

    return undefined;
  }

  private extractToolSideEffects(tool: Record<string, unknown>): ActivityPayload[] {
    const intent = this.extractToolIntent(tool);
    if (!intent || intent.type === "command_intent") {
      return [];
    }

    return [intent];
  }

  private extractToolResult(tool: Record<string, unknown>): string | undefined {
    const result = this.pickObject(tool.result);
    const success = result ? this.pickObject(result.success) : undefined;
    return this.pickString(result?.output, result?.text, success?.output, success?.message);
  }

  private extractToolExitCode(tool: Record<string, unknown> | undefined): number {
    if (!tool) {
      return 0;
    }

    const result = this.pickObject(tool.result);
    const exitCode = Number(result?.exitCode ?? result?.exit_code ?? 0);
    return Number.isFinite(exitCode) ? exitCode : 0;
  }

  private pickNestedObject(object: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
    for (const key of keys) {
      const value = object[key];
      if (value && typeof value === "object") {
        return value as Record<string, unknown>;
      }
    }

    return undefined;
  }

  private pickObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  }

  private pickString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    return undefined;
  }
}
