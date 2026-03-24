import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentAdapter, AdapterHooks } from "./agent-adapter.ts";
import type { ActivityPayload, SessionRecord, TaskRecord } from "../domain.ts";
import { parseJsonSafe } from "../utils/json.ts";
import { createTerminalSpawnPlan } from "../utils/terminal-spawn.ts";

interface CodexCliAdapterOptions {
  binPath?: string;
  binArgs?: string[];
  codexHome: string;
  env?: NodeJS.ProcessEnv;
}

interface PendingCommand {
  cmd: string;
  sideEffects: ActivityPayload[];
  intentEvents: ActivityPayload[];
}

export class CodexCliAdapter implements AgentAdapter {
  readonly name = "codex-cli";

  private readonly binPath: string;
  private readonly binArgs: string[];
  private readonly codexHome: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly stopRequested = new Set<string>();

  constructor(options: CodexCliAdapterOptions) {
    this.binPath = options.binPath ?? process.env.ASYNQ_AGENTD_CODEX_BIN ?? "codex";
    this.binArgs = options.binArgs ?? [];
    this.codexHome = options.codexHome;
    this.env = options.env;
  }

  async runTask(task: TaskRecord, session: SessionRecord, hooks: AdapterHooks): Promise<void> {
    const prompt = this.buildPrompt(task, session);
    const resumeSessionId = this.pickResumeSessionId(task, session);
    const commandArgs = [
      ...this.binArgs,
      ...this.buildCodexArgs(task, prompt, resumeSessionId),
    ];
    const spawnPlan = createTerminalSpawnPlan(this.binPath, commandArgs);

    hooks.onSessionPatch({
      codex_home: this.codexHome,
      codex_command: [this.binPath, ...commandArgs].join(" "),
      codex_spawn_command: [spawnPlan.command, ...spawnPlan.args].join(" "),
      codex_resume_session_id: resumeSessionId,
      codex_run_mode: resumeSessionId ? "resume" : "exec",
      terminal_mode: spawnPlan.mode,
      terminal_transport: spawnPlan.transport,
    });

    await new Promise<void>((resolve, reject) => {
      const child = spawn(spawnPlan.command, spawnPlan.args, {
        cwd: task.project_path,
        env: {
          ...process.env,
          ...this.env,
          CODEX_HOME: this.codexHome,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.processes.set(session.id, child);
      hooks.onSessionPatch({
        adapter_pid: child.pid ?? null,
      });

      const pendingCommands = new Map<string, PendingCommand>();
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

          const metadataPatch = this.extractSessionMetadata(entry);
          if (metadataPatch) {
            hooks.onSessionPatch(metadataPatch);
          }

          for (const payload of this.mapEntryToActivity(entry, pendingCommands)) {
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

        reject(new Error(stderrText || `Codex exited with code ${code ?? "unknown"}`));
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

  canResumeTask(task: TaskRecord, session: SessionRecord): boolean {
    return Boolean(this.pickResumeSessionId(task, session));
  }

  writeTerminalInput(sessionId: string, input: string): void {
    const child = this.processes.get(sessionId);
    if (!child?.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error(`Codex session ${sessionId} is not accepting terminal input`);
    }

    child.stdin.write(input);
  }

  private buildCodexArgs(task: TaskRecord, prompt: string, resumeSessionId?: string): string[] {
    const model = task.model_preference?.trim();
    if (resumeSessionId) {
      return [
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        ...(model ? ["-m", model] : []),
        resumeSessionId,
        prompt,
      ];
    }

    return [
      "exec",
      "--json",
      "--full-auto",
      "--skip-git-repo-check",
      "--cd",
      task.project_path,
      ...(model ? ["-m", model] : []),
      prompt,
    ];
  }

  private pickResumeSessionId(task: TaskRecord, session: SessionRecord): string | undefined {
    const fromMetadata = this.pickString(session.metadata?.codex_session_id);
    if (fromMetadata) {
      return fromMetadata;
    }

    if (task.context?.previous_session_id && this.isLikelyCodexSessionId(task.context.previous_session_id)) {
      return task.context.previous_session_id;
    }

    return undefined;
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

  private extractSessionMetadata(entry: Record<string, unknown>): Record<string, unknown> | undefined {
    if (entry.type !== "session_meta" || typeof entry.payload !== "object" || !entry.payload) {
      return undefined;
    }

    const payload = entry.payload as Record<string, unknown>;
    return {
      codex_session_id: this.pickString(payload.id),
      codex_cwd: this.pickString(payload.cwd),
      codex_cli_version: this.pickString(payload.cli_version),
      codex_originator: this.pickString(payload.originator),
      codex_model_provider: this.pickString(payload.model_provider),
    };
  }

  private mapEntryToActivity(
    entry: Record<string, unknown>,
    pendingCommands: Map<string, PendingCommand>,
  ): ActivityPayload[] {
    const entryType = this.pickString(entry.type);
    const payload = this.getNestedPayload(entry);
    const nestedType = this.pickString(payload?.type);
    const item = typeof entry.item === "object" && entry.item ? entry.item as Record<string, unknown> : undefined;
    const itemType = this.pickString(item?.type);

    if (entryType === "event_msg" && nestedType === "agent_message") {
      const message = this.pickString(payload?.message);
      return message ? [
        { type: "agent_output", message },
        { type: "agent_thinking", summary: message },
      ] : [];
    }

    if (entryType === "item.completed" && itemType === "agent_message") {
      const message = this.pickString(item?.text);
      return message ? [
        { type: "agent_output", message },
        { type: "agent_thinking", summary: message },
      ] : [];
    }

    if ((entryType === "item.started" || entryType === "item.completed") && itemType === "command_execution") {
      const command = this.pickString(item?.command);
      if (!command) {
        return [];
      }

      if (entryType === "item.started") {
        return [{ type: "agent_thinking", summary: `Running command: ${command}` }];
      }

      const exitCode = typeof item?.exit_code === "number" ? item.exit_code : 0;
      return [{
        type: "command_run",
        cmd: command,
        exit_code: exitCode,
        duration_ms: 0,
        stdout_preview: this.pickString(item?.aggregated_output),
      }];
    }

    if (entryType === "response_item" && nestedType === "reasoning") {
      const summary = this.extractReasoningSummary(payload);
      return summary ? [{ type: "agent_thinking", summary }] : [];
    }

    if (entryType === "response_item" && (nestedType === "function_call" || nestedType === "custom_tool_call") && payload) {
      const command = this.describeCommand(payload);
      const sideEffects = this.extractSideEffects(payload);
      const callId = this.pickString(payload.call_id);
      if (callId) {
        pendingCommands.set(callId, {
          cmd: command,
          sideEffects,
          intentEvents: this.buildIntentEvents(payload, command, sideEffects),
        });
      }
      return this.buildIntentEvents(payload, command, sideEffects);
    }

    if (entryType === "response_item" && (nestedType === "function_call_output" || nestedType === "custom_tool_call_output") && payload) {
      const callId = this.pickString(payload.call_id);
      if (!callId) {
        return [];
      }

      const pending = pendingCommands.get(callId);
      pendingCommands.delete(callId);
      const output = this.pickString(payload.output);
      const parsedOutput = this.parseJsonObject(output);
      const metadata = parsedOutput && typeof parsedOutput.metadata === "object"
        ? parsedOutput.metadata as Record<string, unknown>
        : undefined;
      const stdoutPreview = this.pickString(parsedOutput?.output, this.extractOutputPreview(output));
      const durationMs = this.extractDurationMs(output, metadata);
      const command = pending?.cmd ?? "unknown";
      const events: ActivityPayload[] = [{
        type: "command_run",
        cmd: command,
        exit_code: this.extractExitCode(output, metadata),
        duration_ms: durationMs,
        stdout_preview: stdoutPreview,
      }];
      const testRun = this.extractTestRun(command, output, stdoutPreview, durationMs);
      if (testRun) {
        events.push(testRun);
      }
      return [...events, ...(pending?.sideEffects ?? [])];
    }

    if (entryType === "event_msg" && nestedType === "token_count" && payload && typeof payload.info === "object" && payload.info) {
      const info = payload.info as Record<string, unknown>;
      if (typeof info.total_token_usage === "object" && info.total_token_usage) {
        const usage = info.total_token_usage as Record<string, unknown>;
        return [{
          type: "model_call",
          model: this.pickString(usage.model, info.model) ?? "unknown",
          tokens_in: Number(usage.input_tokens ?? usage.input ?? 0),
          tokens_out: Number(usage.output_tokens ?? usage.output ?? 0) + Number(usage.reasoning_output_tokens ?? 0),
          cost_usd: Number(usage.cost_usd ?? 0),
        }];
      }
    }

    return [];
  }

  private getNestedPayload(entry: Record<string, unknown>): Record<string, unknown> | undefined {
    if (typeof entry.payload === "object" && entry.payload) {
      return entry.payload as Record<string, unknown>;
    }

    if (typeof entry.item === "object" && entry.item) {
      return entry.item as Record<string, unknown>;
    }

    return undefined;
  }

  private describeCommand(payload: Record<string, unknown>): string {
    if (payload.type === "function_call") {
      const args = this.parseJsonObject(this.pickString(payload.arguments));
      const cmd = args && typeof args.cmd === "string" ? args.cmd.trim() : "";
      return cmd || `tool:${this.pickString(payload.name) ?? "unknown"}`;
    }

    const name = this.pickString(payload.name) ?? "unknown";
    const input = this.pickString(payload.input);
    const firstLine = input?.split("\n")[0]?.trim();
    return firstLine || `tool:${name}`;
  }

  private extractSideEffects(payload: Record<string, unknown>): ActivityPayload[] {
    if (this.pickString(payload.name) !== "apply_patch") {
      return [];
    }

    const input = this.pickString(payload.input);
    if (!input) {
      return [];
    }

    const events: ActivityPayload[] = [];
    let current:
      | { kind: "file_create"; path: string; linesAdded: number; linesRemoved: number }
      | { kind: "file_edit"; path: string; linesAdded: number; linesRemoved: number }
      | { kind: "file_delete"; path: string; linesAdded: number; linesRemoved: number }
      | undefined;

    const flush = () => {
      if (!current) {
        return;
      }

      if (current.kind === "file_create") {
        events.push({ type: "file_create", path: current.path });
      } else if (current.kind === "file_delete") {
        events.push({ type: "file_delete", path: current.path });
      } else {
        events.push({
          type: "file_edit",
          path: current.path,
          lines_added: current.linesAdded,
          lines_removed: current.linesRemoved,
        });
      }
    };

    for (const line of input.split("\n")) {
      if (line.startsWith("*** Update File: ")) {
        flush();
        current = { kind: "file_edit", path: line.slice(17).trim(), linesAdded: 0, linesRemoved: 0 };
        continue;
      }

      if (line.startsWith("*** Add File: ")) {
        flush();
        current = { kind: "file_create", path: line.slice(14).trim(), linesAdded: 0, linesRemoved: 0 };
        continue;
      }

      if (line.startsWith("*** Delete File: ")) {
        flush();
        current = { kind: "file_delete", path: line.slice(17).trim(), linesAdded: 0, linesRemoved: 0 };
        continue;
      }

      if (!current) {
        continue;
      }

      if (line.startsWith("+") && !line.startsWith("+++")) {
        current.linesAdded += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        current.linesRemoved += 1;
      }
    }

    flush();
    return events;
  }

  private buildIntentEvents(
    payload: Record<string, unknown>,
    command: string,
    sideEffects: ActivityPayload[],
  ): ActivityPayload[] {
    const events: ActivityPayload[] = [{
      type: "command_intent",
      cmd: command,
      source: payload.type === "function_call" ? "tool_call" : "custom_tool_call",
    }];

    const fileIntent = this.buildFileBatchIntent(sideEffects);
    if (fileIntent) {
      events.push(fileIntent);
    }

    return events;
  }

  private buildFileBatchIntent(sideEffects: ActivityPayload[]): ActivityPayload | undefined {
    const files = sideEffects.flatMap((event) => {
      if (event.type === "file_create") {
        return [{ path: event.path, action: "created" as const }];
      }

      if (event.type === "file_delete") {
        return [{ path: event.path, action: "deleted" as const }];
      }

      if (event.type === "file_edit") {
        return [{
          path: event.path,
          action: "edited" as const,
          lines_added: event.lines_added,
          lines_removed: event.lines_removed,
        }];
      }

      return [];
    });

    if (files.length === 0) {
      return undefined;
    }

    return {
      type: "file_batch_intent",
      summary: `Agent is about to modify ${files.length} file${files.length === 1 ? "" : "s"}.`,
      files,
    };
  }

  private extractTestRun(
    command: string,
    rawOutput: string | undefined,
    stdoutPreview: string | undefined,
    durationMs: number,
  ): ActivityPayload | undefined {
    if (!/\b(test|vitest|jest|pytest|mocha|ava)\b/i.test(command) && !/\b(cargo|go|pnpm|npm|bun|yarn)\s+test\b/i.test(command)) {
      return undefined;
    }

    const output = [stdoutPreview, rawOutput].filter((value): value is string => Boolean(value)).join("\n");
    const passed = this.pickNumber(output, [/ℹ pass (\d+)/i, /\b(\d+)\s+passed\b/i]);
    const failed = this.pickNumber(output, [/ℹ fail (\d+)/i, /\b(\d+)\s+failed\b/i]);
    const skipped = this.pickNumber(output, [/ℹ skipped (\d+)/i, /\b(\d+)\s+skipped\b/i]);
    if (passed === undefined && failed === undefined && skipped === undefined) {
      return undefined;
    }

    return {
      type: "test_run",
      passed: passed ?? 0,
      failed: failed ?? 0,
      skipped: skipped ?? 0,
      duration_ms: durationMs,
    };
  }

  private extractReasoningSummary(payload?: Record<string, unknown>): string | undefined {
    if (!payload || !Array.isArray(payload.summary)) {
      return undefined;
    }

    const joined = payload.summary
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object") {
          return this.pickString((item as Record<string, unknown>).text);
        }

        return undefined;
      })
      .filter((value): value is string => Boolean(value))
      .join("\n");

    return joined || undefined;
  }

  private parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
    if (!value) {
      return undefined;
    }

    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      return undefined;
    }

    const parsed = parseJsonSafe<Record<string, unknown> | undefined>(trimmed, undefined);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  }

  private extractExitCode(output: string | undefined, metadata?: Record<string, unknown>): number {
    if (typeof metadata?.exit_code === "number") {
      return metadata.exit_code;
    }

    const match = output?.match(/Process exited with code (\d+)/);
    return match ? Number(match[1]) : 0;
  }

  private extractDurationMs(output: string | undefined, metadata?: Record<string, unknown>): number {
    if (typeof metadata?.duration_seconds === "number") {
      return Math.round(metadata.duration_seconds * 1000);
    }

    const match = output?.match(/Wall time:\s*([\d.]+)\s*seconds/);
    return match ? Math.round(Number(match[1]) * 1000) : 0;
  }

  private extractOutputPreview(output: string | undefined): string | undefined {
    if (!output) {
      return undefined;
    }

    const markerIndex = output.indexOf("Output:\n");
    if (markerIndex >= 0) {
      const text = output.slice(markerIndex + 8).trim();
      return text || undefined;
    }

    const trimmed = output.trim();
    return trimmed || undefined;
  }

  private pickNumber(text: string, patterns: RegExp[]): number | undefined {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        return Number(match[1]);
      }
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

  private isLikelyCodexSessionId(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      || /^[0-9a-f]{26,}$/i.test(value);
  }
}
