import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AsynqAgentdStorage } from "../db/storage.ts";
import type { DaemonConfig, RecentWorkRecord, SessionRecord, SummaryCacheRecord } from "../domain.ts";
import { parseJsonSafe } from "../utils/json.ts";
import { nowIso } from "../utils/time.ts";
import { EventStreamService } from "./event-stream-service.ts";
import { RuntimeDiscoveryService } from "./runtime-discovery-service.ts";

type SummaryScope = SummaryCacheRecord["scope"];

interface SessionSummaryResult {
  summary: string;
}

interface ContinueSummaryResult {
  title: string;
  summary: string;
  nextMove?: string;
}

interface ContinueSummaryInput {
  id: string;
  record: RecentWorkRecord;
  fallbackTitle: string;
  fallbackSummary: string;
}

interface SummaryProvider {
  readonly id: string;
  isAvailable(): boolean;
  summarize(params: {
    cwd?: string;
    schema: Record<string, unknown>;
    prompt: string;
    model?: string;
  }): Promise<Record<string, unknown>>;
}

interface SummaryServiceOptions {
  storage: AsynqAgentdStorage;
  events?: EventStreamService;
  runtimes: RuntimeDiscoveryService;
  getConfig: () => DaemonConfig;
  providers?: SummaryProvider[];
}

function hashInput(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function execFileJson(command: string, args: string[], cwd?: string, envOverrides?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      maxBuffer: 1024 * 1024 * 2,
      env: {
        ...process.env,
        ...envOverrides,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

class ClaudeSummaryProvider implements SummaryProvider {
  readonly id = "claude";
  private readonly runtimes: RuntimeDiscoveryService;

  constructor(runtimes: RuntimeDiscoveryService) {
    this.runtimes = runtimes;
  }

  isAvailable(): boolean {
    return this.runtimes.list().some((runtime) => runtime.id === "claude-code" && runtime.available && runtime.path);
  }

  async summarize(params: {
    cwd?: string;
    schema: Record<string, unknown>;
    prompt: string;
    model?: string;
  }): Promise<Record<string, unknown>> {
    const runtime = this.runtimes.list().find((item) => item.id === "claude-code" && item.available && item.path);
    if (!runtime?.path) {
      throw new Error("Claude runtime is unavailable");
    }

    const args = [
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--permission-mode",
      "bypassPermissions",
      "--tools",
      "",
      "--json-schema",
      JSON.stringify(params.schema),
      ...(params.model ? ["--model", params.model] : []),
      params.prompt,
    ];
    const stdout = await execFileJson(runtime.path, args, params.cwd);
    return parseJsonSafe<Record<string, unknown>>(stdout, {});
  }
}

class CodexSummaryProvider implements SummaryProvider {
  readonly id = "codex";
  private readonly runtimes: RuntimeDiscoveryService;

  constructor(runtimes: RuntimeDiscoveryService) {
    this.runtimes = runtimes;
  }

  isAvailable(): boolean {
    return this.runtimes.list().some((runtime) => runtime.id === "codex" && runtime.available && runtime.path);
  }

  async summarize(params: {
    cwd?: string;
    schema: Record<string, unknown>;
    prompt: string;
    model?: string;
  }): Promise<Record<string, unknown>> {
    const runtime = this.runtimes.list().find((item) => item.id === "codex" && item.available && item.path);
    if (!runtime?.path) {
      throw new Error("Codex runtime is unavailable");
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "asynq-summary-codex-"));
    const schemaPath = join(tempRoot, "summary-schema.json");
    const outputPath = join(tempRoot, "summary-output.json");

    try {
      await writeFile(schemaPath, JSON.stringify(params.schema, null, 2), "utf8");
      await execFileJson(runtime.path, [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        ...(params.cwd ? ["--cd", params.cwd] : []),
        ...(params.model ? ["-m", params.model] : []),
        params.prompt,
      ], params.cwd, {
        CODEX_HOME: tempRoot,
      });

      const payload = await readFile(outputPath, "utf8");
      return parseJsonSafe<Record<string, unknown>>(payload.trim(), {});
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

function sanitizeTitle(value: string | undefined, fallback: string): string {
  return compactText(value?.trim() || fallback, 72);
}

function sanitizeSummary(value: string | undefined, fallback: string): string {
  return compactText(value?.trim() || fallback, 160);
}

export class SummaryService {
  private readonly storage: AsynqAgentdStorage;
  private readonly events?: EventStreamService;
  private readonly getConfig: () => DaemonConfig;
  private readonly providers: SummaryProvider[];
  private readonly inflight = new Set<string>();

  constructor(options: SummaryServiceOptions) {
    this.storage = options.storage;
    this.events = options.events;
    this.getConfig = options.getConfig;
    this.providers = options.providers ?? [
      new ClaudeSummaryProvider(options.runtimes),
      new CodexSummaryProvider(options.runtimes),
    ];
  }

  getSessionCardSummary(session: SessionRecord, fallback: string): string {
    const input = {
      title: session.title,
      state: session.state,
      project_path: session.project_path,
      branch: session.branch,
      fallback,
      recent_events: this.storage.listActivity({ session_id: session.id, limit: 5 }).map((event) => event.payload),
    };
    const key = `session_card:${session.id}`;
    const inputHash = hashInput(input);
    const cached = this.storage.getSummaryCache(key);
    if (cached?.input_hash === inputHash) {
      return sanitizeSummary(pickString(cached.content.summary), fallback);
    }

    void this.refreshSummary({
      key,
      scope: "session_card",
      entityId: session.id,
      sessionId: session.id,
      cwd: session.project_path,
      inputHash,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
        },
        required: ["summary"],
      },
      prompt: [
        "Write a concise operator-facing summary for a mobile dashboard card.",
        "Respond as JSON matching the schema.",
        "Keep it factual, 1 sentence, under 160 characters, and avoid repeating file lists verbatim.",
        "",
        JSON.stringify(input, null, 2),
      ].join("\n"),
      coerce: (payload) => ({
        summary: sanitizeSummary(pickString(payload.summary), fallback),
      }),
    });

    return sanitizeSummary(fallback, fallback);
  }

  getContinueCard(record: RecentWorkRecord, fallbackTitle: string, fallbackSummary: string): ContinueSummaryResult {
    return this.readContinueCard(record, fallbackTitle, fallbackSummary);
  }

  readContinueCard(record: RecentWorkRecord, fallbackTitle: string, fallbackSummary: string): ContinueSummaryResult {
    const metadata = record.metadata ?? {};
    const input = {
      format_version: 3,
      title: record.title,
      fallback_title: fallbackTitle,
      source_type: record.source_type,
      status: record.status,
      project_path: record.project_path,
      summary: record.summary,
      fallback_summary: fallbackSummary,
      last_reasoning_summary: metadata.last_reasoning_summary,
      last_agent_message: metadata.last_agent_message,
      last_user_message: metadata.last_user_message,
    };
    const key = `continue_card:${record.id}`;
    const inputHash = hashInput(input);
    const cached = this.storage.getSummaryCache(key);
    if (cached?.input_hash === inputHash) {
      return {
        title: sanitizeTitle(pickString(cached.content.title), fallbackTitle),
        summary: sanitizeSummary(pickString(cached.content.summary), fallbackSummary),
        nextMove: pickString(cached.content.next_move),
      };
    }

    return {
      title: sanitizeTitle(fallbackTitle, record.title),
      summary: sanitizeSummary(fallbackSummary, fallbackSummary),
    };
  }

  prepareContinueCard(record: RecentWorkRecord, fallbackTitle: string, fallbackSummary: string): void {
    this.prepareContinueCards([{ id: record.id, record, fallbackTitle, fallbackSummary }]);
  }

  prepareContinueCards(records: Array<RecentWorkRecord | ContinueSummaryInput>): void {
    const inputs = records.map((record) => "record" in record
      ? record
      : {
          id: record.id,
          record,
          fallbackTitle: record.title,
          fallbackSummary: record.summary ?? "Recent work is available to continue.",
        });
    if (inputs.length === 0) {
      return;
    }

    const groups = new Map<string, ContinueSummaryInput[]>();
    for (const input of inputs) {
      const providerHint = this.inferContinueProviderId(input.record);
      const groupKey = providerHint ?? "auto";
      const existing = groups.get(groupKey) ?? [];
      existing.push(input);
      groups.set(groupKey, existing);
    }

    for (const [groupKey, groupInputs] of groups.entries()) {
      this.prepareContinueCardBatch(groupInputs, groupKey === "auto" ? undefined : groupKey);
    }
  }

  private prepareContinueCardBatch(inputs: ContinueSummaryInput[], preferredProviderId?: string): void {
    const provider = this.selectProvider(preferredProviderId);
    if (!provider || provider === "heuristic") {
      return;
    }

    const inputEntries = inputs.map(({ id, record, fallbackTitle, fallbackSummary }) => {
      const metadata = record.metadata ?? {};
      return {
        id,
        input: {
          format_version: 3,
          title: record.title,
          fallback_title: fallbackTitle,
          source_type: record.source_type,
          status: record.status,
          project_path: record.project_path,
          summary: record.summary,
          fallback_summary: fallbackSummary,
          last_reasoning_summary: metadata.last_reasoning_summary,
          last_agent_message: metadata.last_agent_message,
          last_user_message: metadata.last_user_message,
        },
      };
    });
    const inputHash = hashInput(inputEntries.map((entry) => entry.input));
    const batchKey = `continue_card_batch:${preferredProviderId ?? "auto"}:${inputHash}`;
    if (this.inflight.has(batchKey)) {
      return;
    }

    const staleInputs = inputEntries.filter(({ id, input }) => {
      const cached = this.storage.getSummaryCache(`continue_card:${id}`);
      return cached?.input_hash !== hashInput(input);
    });
    if (staleInputs.length === 0) {
      return;
    }

    this.inflight.add(batchKey);
    const model = this.getConfig().summaries.model;
    void provider.summarize({
      cwd: staleInputs.find((entry) => entry.input.project_path)?.input.project_path,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                summary: { type: "string" },
                next_move: { type: "string" },
              },
              required: ["id", "title", "summary"],
            },
          },
        },
        required: ["items"],
      },
      prompt: [
        "Rewrite recent work into compact mobile cards for Asynq Buddy.",
        "Respond as JSON matching the schema.",
        "For each item:",
        "- preserve a clean existing thread title when available",
        "- for Codex, prefer thread_name over the first raw prompt whenever available",
        "- summary must be one factual sentence under 160 characters",
        "- next_move is optional and should be a short concrete next step if the latest agent response suggests one",
        "- never output encoded text, JSON, or file-path noise as title or summary",
        "",
        JSON.stringify(staleInputs, null, 2),
      ].join("\n"),
      model,
    }).then((payload) => {
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const entry of staleInputs) {
        const id = entry.id;
        const fallbackTitle = pickString(entry.input.fallback_title) ?? pickString(entry.input.title) ?? "Recent work ready to continue";
        const fallbackSummary = pickString(entry.input.fallback_summary) ?? "Recent work is available to continue.";
        const match = items.find((item) => item && typeof item === "object" && pickString((item as Record<string, unknown>).id) === id) as Record<string, unknown> | undefined;
        const content = {
          title: sanitizeTitle(pickString(match?.title), fallbackTitle),
          summary: sanitizeSummary(pickString(match?.summary), fallbackSummary),
          next_move: pickString(match?.next_move),
        };
        this.storage.upsertSummaryCache({
          key: `continue_card:${id}`,
          scope: "continue_card",
          entity_id: id,
          input_hash: hashInput(entry.input),
          provider: provider.id,
          content,
          updated_at: nowIso(),
        });
        this.events?.publish({
          kind: "summary",
          session_id: `recent_work:${id}`,
          created_at: nowIso(),
          payload: {
            entity_type: "recent_work",
            entity_id: id,
            scope: "continue_card",
            provider: provider.id,
          },
        });
      }
    }).catch(() => {
      // Heuristic fallback remains active.
    }).finally(() => {
      this.inflight.delete(batchKey);
    });
  }

  private inferContinueProviderId(record: RecentWorkRecord): string | undefined {
    if (record.source_type.includes("claude")) {
      return "claude";
    }

    if (record.source_type.includes("codex")) {
      return "codex";
    }

    return undefined;
  }

  private selectProvider(preferredProviderId?: string): SummaryProvider | "heuristic" | undefined {
    const config = this.getConfig().summaries;
    if (!config.enabled || config.provider === "none") {
      return undefined;
    }

    if (config.provider === "heuristic") {
      return "heuristic";
    }

    if (config.provider === "claude") {
      return this.providers.find((provider) => provider.id === "claude" && provider.isAvailable());
    }

    if (config.provider === "codex") {
      return this.providers.find((provider) => provider.id === "codex" && provider.isAvailable());
    }

    if (preferredProviderId) {
      return this.providers.find((provider) => provider.id === preferredProviderId && provider.isAvailable())
        ?? this.providers.find((provider) => provider.isAvailable())
        ?? "heuristic";
    }

    return this.providers.find((provider) => provider.isAvailable()) ?? "heuristic";
  }

  private refreshSummary(options: {
    key: string;
    scope: SummaryScope;
    entityId: string;
    sessionId?: string;
    cwd?: string;
    inputHash: string;
    schema: Record<string, unknown>;
    prompt: string;
    coerce: (payload: Record<string, unknown>) => Record<string, unknown>;
  }): void {
    if (this.inflight.has(options.key)) {
      return;
    }

    const provider = this.selectProvider();
    if (!provider || provider === "heuristic") {
      return;
    }

    this.inflight.add(options.key);
    const model = this.getConfig().summaries.model;
    void provider.summarize({
      cwd: options.cwd,
      schema: options.schema,
      prompt: compactText(options.prompt, this.getConfig().summaries.max_input_chars),
      model,
    }).then((payload) => {
      const content = options.coerce(payload);
      const existing = this.storage.getSummaryCache(options.key);
      if (
        existing?.input_hash === options.inputHash
        && JSON.stringify(existing.content) === JSON.stringify(content)
      ) {
        return;
      }

      this.storage.upsertSummaryCache({
        key: options.key,
        scope: options.scope,
        entity_id: options.entityId,
        session_id: options.sessionId,
        input_hash: options.inputHash,
        provider: provider.id,
        content,
        updated_at: nowIso(),
      });
      this.events?.publish({
        kind: "summary",
        session_id: options.sessionId ?? `recent_work:${options.entityId}`,
        created_at: nowIso(),
        payload: {
          entity_type: options.scope === "continue_card" ? "recent_work" : "session",
          entity_id: options.entityId,
          scope: options.scope,
          provider: provider.id,
        },
      });
    }).catch(() => {
      // Heuristic fallback remains active.
    }).finally(() => {
      this.inflight.delete(options.key);
    });
  }
}
