import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import type {
  ActivityPayload,
  ActivityRecord,
  ObservedTakeoverContext,
  RecentWorkListItem,
  RecentWorkRecord,
  TakeoverSuccessCheck,
} from "../domain.ts";
import { nowIso } from "../utils/time.ts";
import { parseJsonSafe } from "../utils/json.ts";
import type { AsynqAgentdStorage } from "../db/storage.ts";
import { TaskService } from "./task-service.ts";
import type { EventStreamService } from "./event-stream-service.ts";

const INDEXABLE_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt"]);
const IGNORED_FILE_NAMES = new Set(["settings.json"]);
const MAX_FULL_CODEX_SESSION_BYTES = 4 * 1024 * 1024;
const CODEX_SESSION_HEAD_BYTES = 256 * 1024;
const CODEX_SESSION_TAIL_BYTES = 1024 * 1024;
const CLAUDE_DESKTOP_ACTIVE_WINDOW_MS = 2 * 60 * 1000;

interface ClaudeSessionMeta {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

interface ClaudeTranscriptEntry {
  type?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
  };
  lastPrompt?: string;
}

interface RecentWorkServiceOptions {
  claudePath: string;
  claudeDesktopPath?: string;
  codexPath: string;
  events?: EventStreamService;
  onRecentWorkUpdated?: (record: RecentWorkRecord) => void;
  onRecentWorkBatchUpdated?: (records: RecentWorkRecord[]) => void;
}

interface PendingCodexCommand {
  cmd: string;
  sideEffects: ActivityPayload[];
  approvalRequest?: Extract<ActivityPayload, { type: "approval_requested" }>;
}

interface ClaudeDesktopSessionMeta {
  sessionId: string;
  title?: string;
  initialMessage?: string;
  updatedAt: string;
  lastActivityAtMs?: number;
  createdAt?: string;
  projectPath?: string;
  model?: string;
  isArchived: boolean;
  sourcePath: string;
}

export class RecentWorkService {
  private readonly storage: AsynqAgentdStorage;
  private readonly tasks: TaskService;
  private readonly claudePath: string;
  private readonly claudeDesktopPath: string;
  private readonly codexPath: string;
  private readonly events?: EventStreamService;
  private readonly onRecentWorkUpdated?: (record: RecentWorkRecord) => void;
  private readonly onRecentWorkBatchUpdated?: (records: RecentWorkRecord[]) => void;
  private watchers: Array<ReturnType<typeof watch>> = [];
  private rescanTimer?: NodeJS.Timeout;
  private rescanInterval?: NodeJS.Timeout;

  constructor(storage: AsynqAgentdStorage, tasks: TaskService, options: RecentWorkServiceOptions) {
    this.storage = storage;
    this.tasks = tasks;
    this.claudePath = options.claudePath;
    this.claudeDesktopPath = options.claudeDesktopPath ?? "";
    this.codexPath = options.codexPath;
    this.events = options.events;
    this.onRecentWorkUpdated = options.onRecentWorkUpdated;
    this.onRecentWorkBatchUpdated = options.onRecentWorkBatchUpdated;
  }

  list(options?: {
    includeActivityPreview?: boolean;
    previewLimit?: number;
    compact?: boolean;
    previewTypes?: ActivityPayload["type"][];
  }): RecentWorkListItem[] {
    const records = this.storage.listRecentWork();
    if (!options?.includeActivityPreview) {
      return records;
    }

    const previewLimit = options.previewLimit ?? 3;
    const compact = options.compact ?? true;
    const previewTypes = options.previewTypes;

    return records.map((record) => ({
      ...record,
      activity_preview: record.source_type === "codex-session-file" || record.source_type === "claude-session"
        ? this.filterActivityByType(this.listImportedActivity(record.id, previewLimit, compact), previewTypes)
        : [],
    }));
  }

  get(id: string): RecentWorkRecord | undefined {
    return this.storage.getRecentWork(id);
  }

  scan(): RecentWorkRecord[] {
    const discovered: RecentWorkRecord[] = [];
    const changed: RecentWorkRecord[] = [];
    if (existsSync(this.claudePath)) {
      for (const record of this.scanClaude()) {
        const previous = this.storage.getRecentWork(record.id);
        const merged = this.mergeWithPreviousRecord(record, previous);
        this.storage.upsertRecentWork(merged);
        if (this.didRecentWorkChange(previous, merged)) {
          this.publishRecentWorkUpdate(merged, previous);
          this.onRecentWorkUpdated?.(merged);
          changed.push(merged);
        }
        discovered.push(merged);
      }
    }

    if (this.claudeDesktopPath && existsSync(this.claudeDesktopPath)) {
      for (const record of this.scanClaudeDesktop()) {
        const previous = this.storage.getRecentWork(record.id);
        const merged = this.mergeWithPreviousRecord(record, previous);
        this.storage.upsertRecentWork(merged);
        if (this.didRecentWorkChange(previous, merged)) {
          this.publishRecentWorkUpdate(merged, previous);
          this.onRecentWorkUpdated?.(merged);
          changed.push(merged);
        }
        discovered.push(merged);
      }
    }

    if (existsSync(this.codexPath)) {
      for (const record of this.scanCodex()) {
        const previous = this.storage.getRecentWork(record.id);
        const merged = this.mergeWithPreviousRecord(record, previous);
        this.storage.upsertRecentWork(merged);
        if (this.didRecentWorkChange(previous, merged)) {
          this.publishRecentWorkUpdate(merged, previous);
          this.onRecentWorkUpdated?.(merged);
          changed.push(merged);
        }
        discovered.push(merged);
      }
    }

    if (changed.length > 0) {
      this.onRecentWorkBatchUpdated?.(changed);
    }

    return discovered;
  }

  startWatching(): void {
    if (this.watchers.length > 0) {
      return;
    }

    queueMicrotask(() => {
      this.scan();
    });
    this.rescanInterval = setInterval(() => {
      this.scan();
    }, 5000);

    for (const rootPath of [this.claudePath, this.claudeDesktopPath, this.codexPath]) {
      if (!existsSync(rootPath)) {
        continue;
      }

      this.watchers.push(watch(rootPath, { recursive: true }, () => {
        if (this.rescanTimer) {
          clearTimeout(this.rescanTimer);
        }

        this.rescanTimer = setTimeout(() => {
          this.scan();
        }, 250);
      }));
    }
  }

  stopWatching(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = undefined;
    }
    if (this.rescanInterval) {
      clearInterval(this.rescanInterval);
      this.rescanInterval = undefined;
    }
  }

  continueRecentWork(id: string, instruction?: string) {
    const record = this.get(id);
    if (!record) {
      throw new Error(`Recent work ${id} not found`);
    }

    if (!record.project_path) {
      throw new Error("Recent work item is missing a project_path and cannot be continued yet");
    }

    const contextSummary = this.buildContinuationSummary(record);
    const inferredFocusFiles = this.inferFocusFiles(record);
    const observedTakeover = this.pickObservedTakeover(record);
    return this.tasks.create({
      title: instruction ? `Continue: ${record.title}` : record.title,
      description: instruction
        ? `Continue prior work from ${record.source_path}. ${contextSummary} Developer instruction: ${instruction}`
        : `Continue prior work from ${record.source_path}. ${contextSummary}`,
      project_path: record.project_path,
      agent_type: record.source_type.startsWith("codex") ? "codex" : "claude-code",
      context: {
        source_recent_work_id: record.id,
        source_recent_work_updated_at: record.updated_at,
        source_codex_session_id: record.source_type.startsWith("codex") ? record.id : undefined,
        observed_takeover: observedTakeover,
        files_to_focus: inferredFocusFiles,
      },
    });
  }

  listImportedActivity(id: string, limit?: number, compact = true): ActivityRecord[] {
    const record = this.get(id);
    if (!record) {
      throw new Error(`Recent work ${id} not found`);
    }

    if (record.source_type === "claude-session") {
      return this.parseClaudeActivity(record.source_path, record.id, limit, compact);
    }

    if (record.source_type === "codex-session-file") {
      return this.parseCodexActivity(record.source_path, record.id, limit, compact);
    }

    return [];
  }

  private walk(root: string, depth: number): string[] {
    if (depth < 0) {
      return [];
    }

    const entries = readdirSync(root, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.walk(fullPath, depth - 1));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private publishRecentWorkUpdate(record: RecentWorkRecord, previous?: RecentWorkRecord): void {
    if (!this.events) {
      return;
    }

    if (!this.didRecentWorkChange(previous, record)) {
      return;
    }

    this.events.publish({
      kind: "summary",
      session_id: record.id,
      created_at: nowIso(),
      payload: {
        entity_type: "recent_work",
        entity_id: record.id,
        scope: "continue_card",
        provider: "recent-work-scan",
      },
    });
  }

  private mergeWithPreviousRecord(record: RecentWorkRecord, previous?: RecentWorkRecord): RecentWorkRecord {
    const previousMetadata = previous?.metadata ?? {};
    const nextMetadata = record.metadata ?? {};
    const mergedMetadata = {
      ...previousMetadata,
      ...nextMetadata,
    };

    const resolvedTitle = this.resolveStableTitle(record, previous);
    const resolvedSummary = this.resolveStableSummary(record, previous);

    return {
      ...record,
      title: resolvedTitle,
      summary: resolvedSummary,
      metadata: mergedMetadata,
    };
  }

  private resolveStableTitle(record: RecentWorkRecord, previous?: RecentWorkRecord): string {
    const metadata = record.metadata ?? {};
    const previousMetadata = previous?.metadata ?? {};
    return this.pickString(
      metadata.thread_name,
      metadata.summary_title,
      record.title,
      previousMetadata.thread_name,
      previous?.title,
    ) ?? record.title;
  }

  private resolveStableSummary(record: RecentWorkRecord, previous?: RecentWorkRecord): string | undefined {
    const metadata = record.metadata ?? {};
    return this.pickString(
      record.summary,
      metadata.last_agent_message,
      metadata.last_user_message,
      metadata.last_reasoning_summary,
      previous?.summary,
    );
  }

  private didRecentWorkChange(previous: RecentWorkRecord | undefined, next: RecentWorkRecord): boolean {
    if (!previous) {
      return true;
    }

    return previous.source_path !== next.source_path
      || previous.project_path !== next.project_path
      || previous.title !== next.title
      || previous.summary !== next.summary
      || previous.source_type !== next.source_type
      || previous.status !== next.status
      || previous.updated_at !== next.updated_at
      || JSON.stringify(previous.metadata ?? {}) !== JSON.stringify(next.metadata ?? {});
  }

  private scanClaude(): RecentWorkRecord[] {
    const records: RecentWorkRecord[] = [];

    // Build a set of active session IDs from sessions/*.json
    const activeSessionIds = new Map<string, ClaudeSessionMeta>();
    const sessionsDir = join(this.claudePath, "sessions");
    if (existsSync(sessionsDir)) {
      for (const filePath of this.walk(sessionsDir, 1)) {
        if (extname(filePath) !== ".json") {
          continue;
        }

        const meta = this.parseClaudeSessionMeta(filePath);
        if (meta) {
          activeSessionIds.set(meta.sessionId, meta);
        }
      }
    }

    // Parse transcript files from projects/<encoded-path>/<sessionId>.jsonl
    const projectsDir = join(this.claudePath, "projects");
    if (existsSync(projectsDir)) {
      for (const filePath of this.walk(projectsDir, 4)) {
        if (extname(filePath) !== ".jsonl") {
          continue;
        }

        const sessionId = basename(filePath, ".jsonl");
        const activeMeta = activeSessionIds.get(sessionId);
        const record = this.parseClaudeTranscript(filePath, sessionId, activeMeta);
        if (record) {
          records.push(record);
        }
      }
    }

    // Fallback: index any remaining files that aren't sessions or transcripts
    for (const filePath of this.walk(this.claudePath, 4)) {
      const fileName = basename(filePath);
      const extension = extname(filePath);
      if (IGNORED_FILE_NAMES.has(fileName) || !INDEXABLE_EXTENSIONS.has(extension)) {
        continue;
      }

      // Skip files already handled by specific parsers
      const relDir = dirname(filePath).slice(this.claudePath.length + 1).split("/")[0];
      if (relDir === "sessions" || relDir === "projects") {
        continue;
      }

      const record = this.parseClaudeGenericFile(filePath);
      if (record) {
        records.push(record);
      }
    }

    return records;
  }

  private scanClaudeDesktop(): RecentWorkRecord[] {
    const sessionsRoot = join(this.claudeDesktopPath, "local-agent-mode-sessions");
    if (!existsSync(sessionsRoot)) {
      return [];
    }

    const records: RecentWorkRecord[] = [];
    for (const filePath of this.walk(sessionsRoot, 6)) {
      if (!basename(filePath).startsWith("local_") || extname(filePath) !== ".json") {
        continue;
      }

      const record = this.parseClaudeDesktopSession(filePath);
      if (record) {
        records.push(record);
      }
    }

    return records;
  }

  private parseClaudeDesktopSession(filePath: string): RecentWorkRecord | undefined {
    const text = readFileSync(filePath, "utf8").trim();
    if (!text) {
      return undefined;
    }

    const payload = parseJsonSafe<Record<string, unknown>>(text, {});
    const meta = this.extractClaudeDesktopSessionMeta(payload, filePath);
    if (!meta) {
      return undefined;
    }

    const title = this.pickString(meta.title, meta.initialMessage) ?? basename(filePath, ".json");
    const summary = this.compactClaudeDesktopSummary(meta.initialMessage);

    const isFreshlyActive = !meta.isArchived
      && typeof meta.lastActivityAtMs === "number"
      && Date.now() - meta.lastActivityAtMs <= CLAUDE_DESKTOP_ACTIVE_WINDOW_MS;

    return {
      id: meta.sessionId,
      source_path: meta.sourcePath,
      project_path: meta.projectPath,
      title,
      summary,
      source_type: "claude-desktop-session",
      status: isFreshlyActive ? "active" : "ended",
      updated_at: meta.updatedAt,
      metadata: {
        thread_name: meta.title,
        summary_title: meta.title,
        runtime_label: "Claude Cowork",
        model: meta.model,
        raw_user_input: meta.initialMessage,
        last_user_message: meta.initialMessage,
        started_at: meta.createdAt,
        last_activity_at: meta.updatedAt,
        is_archived: meta.isArchived,
      },
    };
  }

  private extractClaudeDesktopSessionMeta(
    payload: Record<string, unknown>,
    filePath: string,
  ): ClaudeDesktopSessionMeta | undefined {
    const sessionId = this.pickString(payload.sessionId);
    if (!sessionId) {
      return undefined;
    }

    const lastActivityAt = typeof payload.lastActivityAt === "number"
      ? new Date(payload.lastActivityAt).toISOString()
      : statSync(filePath).mtime.toISOString();
    const createdAt = typeof payload.createdAt === "number"
      ? new Date(payload.createdAt).toISOString()
      : undefined;
    const userSelectedFolders = Array.isArray(payload.userSelectedFolders)
      ? payload.userSelectedFolders
      : [];
    const projectPath = userSelectedFolders
      .map((value) => this.pickString(value))
      .find((value): value is string => Boolean(value));

    return {
      sessionId,
      title: this.pickString(payload.title),
      initialMessage: this.pickString(payload.initialMessage),
      updatedAt: lastActivityAt,
      lastActivityAtMs: typeof payload.lastActivityAt === "number" ? payload.lastActivityAt : undefined,
      createdAt,
      projectPath,
      model: this.pickString(payload.model),
      isArchived: Boolean(payload.isArchived),
      sourcePath: filePath,
    };
  }

  private compactClaudeDesktopSummary(value?: string): string | undefined {
    const text = this.pickString(value);
    if (!text) {
      return undefined;
    }

    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= 220) {
      return normalized;
    }

    return `${normalized.slice(0, 217).trimEnd()}...`;
  }

  private parseClaudeSessionMeta(filePath: string): ClaudeSessionMeta | undefined {
    const text = readFileSync(filePath, "utf8").trim();
    if (!text) {
      return undefined;
    }

    const payload = parseJsonSafe<Record<string, unknown>>(text, {});
    const pid = typeof payload.pid === "number" ? payload.pid : undefined;
    const sessionId = this.pickString(payload.sessionId);
    const cwd = this.pickString(payload.cwd);
    const startedAt = typeof payload.startedAt === "number" ? payload.startedAt : undefined;

    if (!sessionId || !cwd || !startedAt) {
      return undefined;
    }

    return { pid: pid ?? 0, sessionId, cwd, startedAt };
  }

  private parseClaudeTranscript(
    filePath: string,
    sessionId: string,
    activeMeta: ClaudeSessionMeta | undefined,
  ): RecentWorkRecord | undefined {
    const stats = statSync(filePath);
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    if (lines.length === 0) {
      return undefined;
    }

    let cwd: string | undefined = activeMeta?.cwd;
    let gitBranch: string | undefined;
    let model: string | undefined;
    let title: string | undefined;
    let summary: string | undefined;
    let lastUserMessage: string | undefined;
    let lastAssistantMessage: string | undefined;
    let hasLastPrompt = false;
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let toolUseCount = 0;
    const filesModified = new Set<string>();

    for (const line of lines) {
      const entry = parseJsonSafe<ClaudeTranscriptEntry>(line, {});

      if (entry.cwd && !cwd) {
        cwd = entry.cwd;
      }

      if (entry.gitBranch && entry.gitBranch !== "HEAD") {
        gitBranch = entry.gitBranch;
      }

      if (entry.type === "last-prompt") {
        hasLastPrompt = true;
        continue;
      }

      if (entry.type === "file-history-snapshot" || entry.type === "progress") {
        continue;
      }

      if (entry.type === "user" && entry.message?.role === "user") {
        const text = this.extractClaudeMessageText(entry.message.content);
        if (text) {
          if (!title) {
            title = text;
          }
          lastUserMessage = text;
          userMessageCount += 1;
        }
      }

      if (entry.type === "assistant" && entry.message?.role === "assistant") {
        if (entry.message.model && !model) {
          model = entry.message.model;
        }

        const text = this.extractClaudeMessageText(entry.message.content);
        if (text) {
          lastAssistantMessage = text;
          summary = text;
          assistantMessageCount += 1;
        }

        // Count tool uses and extract file paths
        if (Array.isArray(entry.message.content)) {
          for (const part of entry.message.content) {
            if (part && typeof part === "object" && (part as Record<string, unknown>).type === "tool_use") {
              toolUseCount += 1;
              const input = (part as Record<string, unknown>).input as Record<string, unknown> | undefined;
              const toolName = this.pickString((part as Record<string, unknown>).name);
              if (input) {
                const filePath = this.pickString(input.file_path, input.path);
                if (filePath && (toolName === "Edit" || toolName === "Write")) {
                  filesModified.add(filePath);
                }
              }
            }
          }
        }
      }
    }

    // Determine status: active if session meta exists (PID file present), ended if last-prompt marker
    let status: RecentWorkRecord["status"] = "unknown";
    if (activeMeta) {
      status = "active";
    } else if (hasLastPrompt) {
      status = "ended";
    } else if (userMessageCount > 0) {
      // Has messages but no last-prompt and no active session — likely ended
      status = "ended";
    }

    // Derive project path from the encoded directory name
    const projectPath = cwd ?? this.decodeClaudeProjectPath(dirname(filePath));

    return {
      id: sessionId,
      source_path: filePath,
      project_path: projectPath,
      title: title ?? basename(filePath),
      summary,
      source_type: "claude-session",
      status,
      updated_at: stats.mtime.toISOString(),
      metadata: {
        git_branch: gitBranch,
        model,
        last_user_message: lastUserMessage,
        last_assistant_message: lastAssistantMessage,
        user_message_count: userMessageCount,
        assistant_message_count: assistantMessageCount,
        tool_use_count: toolUseCount,
        files_modified: filesModified.size > 0 ? Array.from(filesModified) : undefined,
        started_at: activeMeta ? new Date(activeMeta.startedAt).toISOString() : undefined,
        lines: lines.length,
      },
    };
  }

  private extractClaudeMessageText(content: unknown): string | undefined {
    if (typeof content === "string") {
      return content.trim() || undefined;
    }

    if (Array.isArray(content)) {
      const textParts = content
        .filter((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text")
        .map((part) => this.pickString((part as Record<string, unknown>).text))
        .filter((value): value is string => Boolean(value));

      return textParts.length > 0 ? textParts.join("\n").trim() || undefined : undefined;
    }

    return undefined;
  }

  private decodeClaudeProjectPath(dirPath: string): string | undefined {
    // Claude encodes project paths as directory names. On POSIX it commonly
    // looks like /foo/bar -> -foo-bar, and in our cross-platform fixtures we
    // also allow C:\foo\bar -> C:-foo-bar.
    const dirName = basename(dirPath);
    if (!dirName.startsWith("-")) {
      if (/^[A-Za-z]:-/.test(dirName)) {
        return dirName.replace(/-/g, "/");
      }

      return undefined;
    }

    return dirName.replace(/-/g, "/");
  }

  private parseClaudeActivity(filePath: string, sessionId: string, limit?: number, compact = true): ActivityRecord[] {
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const events: ActivityRecord[] = [];
    let syntheticId = 1;

    for (const line of lines) {
      const entry = parseJsonSafe<ClaudeTranscriptEntry>(line, {});
      const timestamp = entry.timestamp ?? nowIso();

      if (entry.type === "file-history-snapshot" || entry.type === "progress" || entry.type === "last-prompt") {
        continue;
      }

      const payloads = this.mapClaudeEntryToActivity(entry);
      for (const payload of payloads) {
        events.push({
          id: syntheticId,
          session_id: sessionId,
          created_at: timestamp,
          payload,
        });
        syntheticId += 1;
      }
    }

    const collected = compact ? this.condenseImportedActivity(events) : events;
    const ordered = collected.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return typeof limit === "number" ? ordered.slice(0, limit) : ordered;
  }

  private mapClaudeEntryToActivity(entry: ClaudeTranscriptEntry): ActivityPayload[] {
    if (entry.type === "user" && entry.message?.role === "user") {
      const text = this.extractClaudeMessageText(entry.message.content);
      return text
        ? [{ type: "agent_thinking", summary: `User request: ${text}` }]
        : [];
    }

    if (entry.type === "assistant" && entry.message?.role === "assistant") {
      const payloads: ActivityPayload[] = [];
      const content = entry.message.content;

      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") {
            continue;
          }

          const typedPart = part as Record<string, unknown>;

          if (typedPart.type === "text") {
            const text = this.pickString(typedPart.text);
            if (text) {
              payloads.push({ type: "agent_thinking", summary: text });
            }
          }

          if (typedPart.type === "thinking") {
            const thinking = this.pickString(typedPart.thinking);
            if (thinking) {
              // Truncate thinking to a reasonable preview
              const preview = thinking.length > 300 ? `${thinking.slice(0, 297)}...` : thinking;
              payloads.push({ type: "agent_thinking", summary: preview });
            }
          }

          if (typedPart.type === "tool_use") {
            const toolName = this.pickString(typedPart.name) ?? "unknown";
            const input = typedPart.input as Record<string, unknown> | undefined;
            const cmdPayload = this.mapClaudeToolUseToActivity(toolName, input);
            if (cmdPayload) {
              payloads.push(cmdPayload);
            }
          }
        }
      }

      return payloads;
    }

    return [];
  }

  private mapClaudeToolUseToActivity(toolName: string, input: Record<string, unknown> | undefined): ActivityPayload | undefined {
    if (!input) {
      return { type: "command_run", cmd: `tool:${toolName}`, exit_code: 0, duration_ms: 0, stdout_preview: undefined };
    }

    if (toolName === "Bash") {
      return {
        type: "command_run",
        cmd: this.pickString(input.command) ?? "bash",
        exit_code: 0,
        duration_ms: 0,
        stdout_preview: undefined,
      };
    }

    if (toolName === "Edit" || toolName === "Write") {
      const path = this.pickString(input.file_path, input.path) ?? "unknown";
      return {
        type: "file_edit",
        path,
        lines_added: 0,
        lines_removed: 0,
      };
    }

    if (toolName === "Read") {
      return undefined; // Read operations are not interesting as activity
    }

    if (toolName === "Glob" || toolName === "Grep") {
      return undefined; // Search operations are not interesting as activity
    }

    return {
      type: "command_run",
      cmd: `tool:${toolName}`,
      exit_code: 0,
      duration_ms: 0,
      stdout_preview: undefined,
    };
  }

  private parseClaudeGenericFile(filePath: string): RecentWorkRecord | undefined {
    const stats = statSync(filePath);
    const text = readFileSync(filePath, "utf8").trim();
    if (!text) {
      return undefined;
    }

    const firstLine = text.split("\n")[0] ?? "";
    const firstJsonLine = firstLine.startsWith("{") ? parseJsonSafe<Record<string, unknown>>(firstLine, {}) : {};
    const jsonPayload = text.startsWith("{") ? parseJsonSafe<Record<string, unknown>>(text, firstJsonLine) : firstJsonLine;

    const projectPath = this.pickString(
      jsonPayload.projectPath,
      jsonPayload.project_path,
      jsonPayload.cwd,
      jsonPayload.repoPath,
    );
    const title = this.pickString(jsonPayload.title, jsonPayload.name) ?? basename(filePath);
    const summary = this.pickString(
      jsonPayload.summary,
      jsonPayload.prompt,
      typeof jsonPayload.lastMessage === "string" ? jsonPayload.lastMessage : undefined,
    ) ?? firstLine.slice(0, 240);
    const status = this.pickString(jsonPayload.status) === "active"
      ? "active"
      : this.pickString(jsonPayload.status) === "ended"
        ? "ended"
        : "unknown";

    return {
      id: this.createRecentWorkId(filePath),
      source_path: filePath,
      project_path: projectPath,
      title,
      summary,
      source_type: "claude-file",
      status,
      updated_at: stats.mtime.toISOString() || nowIso(),
      metadata: {
        size_bytes: stats.size,
      },
    };
  }

  private pickString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    return undefined;
  }

  private createRecentWorkId(filePath: string): string {
    return `recent_${createHash("sha1").update(filePath).digest("hex")}`;
  }

  private scanCodex(): RecentWorkRecord[] {
    const records: RecentWorkRecord[] = [];
    const indexPath = join(this.codexPath, "session_index.jsonl");
    const sessionsRoot = join(this.codexPath, "sessions");
    const indexById = new Map<string, RecentWorkRecord>();

    if (existsSync(indexPath)) {
      for (const line of readFileSync(indexPath, "utf8").split("\n")) {
        if (!line.trim()) {
          continue;
        }

        const payload = parseJsonSafe<Record<string, unknown>>(line, {});
        const id = this.pickString(payload.id);
        if (!id) {
          continue;
        }

        const indexRecord: RecentWorkRecord = {
          id,
          source_path: indexPath,
          project_path: this.pickString(payload.project_path, payload.projectPath, payload.cwd, payload.repoPath),
          title: this.pickString(payload.thread_name, payload.title) ?? `Codex session ${id}`,
          summary: undefined,
          source_type: "codex-session-index",
          status: "unknown",
          updated_at: this.pickString(payload.updated_at) ?? nowIso(),
          metadata: {
            ...payload,
            thread_name: this.pickString(payload.thread_name, payload.title),
          },
        };
        indexById.set(id, indexRecord);
      }
    }

    const fileRecords = new Map<string, RecentWorkRecord>();
    if (existsSync(sessionsRoot)) {
      for (const filePath of this.walk(sessionsRoot, 5)) {
        if (extname(filePath) !== ".jsonl") {
          continue;
        }

        const record = this.parseCodexSessionFile(filePath);
        if (record) {
          const relatedIndex = indexById.get(record.id);
          fileRecords.set(record.id, this.mergeCodexRecord(record, relatedIndex));
        }
      }
    }

    for (const record of fileRecords.values()) {
      records.push(record);
    }

    for (const [id, indexRecord] of indexById.entries()) {
      if (!fileRecords.has(id)) {
        records.push(indexRecord);
      }
    }

    return records;
  }

  private mergeCodexRecord(record: RecentWorkRecord, relatedIndex?: RecentWorkRecord): RecentWorkRecord {
    const metadata = {
      ...(relatedIndex?.metadata ?? {}),
      ...(record.metadata ?? {}),
      thread_name: this.pickString(
        relatedIndex?.metadata?.thread_name,
        relatedIndex?.title,
        record.metadata?.thread_name,
      ),
    };

    return {
      ...record,
      title: this.pickString(
        metadata.thread_name,
        record.title,
      ) ?? record.title,
      project_path: this.pickString(record.project_path, relatedIndex?.project_path),
      metadata,
    };
  }

  private parseCodexSessionFile(filePath: string): RecentWorkRecord | undefined {
    const stats = statSync(filePath);
    const lines = this.readCodexSessionLines(filePath, stats.size);
    if (lines.length === 0) {
      return undefined;
    }

    let sessionId: string | undefined;
    let cwd: string | undefined;
    let title: string | undefined;
    let summary: string | undefined;
    let status: RecentWorkRecord["status"] = "unknown";
    let lastUserMessage: string | undefined;
    let lastAgentMessage: string | undefined;
    let lastReasoningSummary: string | undefined;
    let taskStartedCount = 0;
    let taskCompletedCount = 0;
    let userMessageCount = 0;
    let agentMessageCount = 0;
    let totalTokens: number | undefined;
    let lastObservedTimestamp: string | undefined;
    let lastTaskStartedIndex = -1;
    let lastTaskCompletedIndex = -1;
    let lastContentIndex = -1;
    let inManagedHandoffTurn = false;
    const pendingApprovalRequests = new Map<string, { action: string; context: string; cmd?: string; detected_at?: string }>();
    const filesModified = new Set<string>();

    for (const [lineIndex, line] of lines.entries()) {
      const entry = parseJsonSafe<Record<string, unknown>>(line, {});
      const entryType = this.pickString(entry.type);
      const nestedPayload = this.getNestedCodexPayload(entry);
      const nestedType = this.pickString(nestedPayload?.type);
      const messageRole = this.pickString(nestedPayload?.role);
      const entryTimestamp = this.extractObservedTimestamp(entry);
      const isUserMessage = entryType === "user_message" || nestedType === "user_message" || (entryType === "response_item" && nestedType === "message" && messageRole === "user");
      const isAgentMessage = entryType === "agent_message" || nestedType === "agent_message" || (entryType === "response_item" && nestedType === "message" && messageRole === "assistant");

      if (entryTimestamp && (!lastObservedTimestamp || entryTimestamp > lastObservedTimestamp)) {
        lastObservedTimestamp = entryTimestamp;
      }

      if (entryType === "session_meta" && typeof entry.payload === "object" && entry.payload) {
        const payload = entry.payload as Record<string, unknown>;
        sessionId = this.pickString(payload.id) ?? sessionId;
        cwd = this.pickString(payload.cwd) ?? cwd;
      }

      if (entryType === "response_item" && (nestedType === "function_call" || nestedType === "custom_tool_call") && nestedPayload) {
        const callId = this.pickString(nestedPayload.call_id);
        const approvalRequest = this.extractCodexApprovalRequest(nestedPayload);
        if (callId && approvalRequest) {
          pendingApprovalRequests.set(callId, {
            ...approvalRequest,
            detected_at: entryTimestamp ?? undefined,
          });
        }
      }

      if (entryType === "response_item" && (nestedType === "function_call_output" || nestedType === "custom_tool_call_output") && nestedPayload) {
        const callId = this.pickString(nestedPayload.call_id);
        if (callId) {
          pendingApprovalRequests.delete(callId);
        }
      }

      if (!title && isUserMessage) {
        const message = this.extractMessageText(isUserMessage && entryType === "user_message" ? entry.payload : nestedPayload);
        if (message && !this.isManagedHandoffRelayPrompt(message)) {
          title = message;
        }
      }

      if (isUserMessage) {
        const message = this.extractMessageText(entryType === "user_message" ? entry.payload : nestedPayload);
        if (message && this.isManagedHandoffRelayPrompt(message)) {
          inManagedHandoffTurn = true;
          continue;
        }

        inManagedHandoffTurn = false;
        if (message) {
          lastUserMessage = message;
          userMessageCount += 1;
          lastContentIndex = lineIndex;
          if (status === "ended") {
            status = "active";
          }
        }
      }

      if (inManagedHandoffTurn) {
        continue;
      }

      if (entryType === "task_complete" || nestedType === "task_complete") {
        status = "ended";
        taskCompletedCount += 1;
        lastTaskCompletedIndex = lineIndex;
      } else if (entryType === "task_started" || nestedType === "task_started") {
        status = "active";
        taskStartedCount += 1;
        lastTaskStartedIndex = lineIndex;
      }

      if (isAgentMessage) {
        const message = this.extractMessageText(entryType === "agent_message" ? entry.payload : nestedPayload);
        if (message) {
          lastAgentMessage = message;
          summary = message;
          agentMessageCount += 1;
          lastContentIndex = lineIndex;
          if (status === "ended") {
            status = "active";
          }
        }
      }

      const changedFiles = this.extractChangedFilePaths(entry, nestedPayload);
      for (const file of changedFiles) {
        filesModified.add(file);
      }

      if ((entryType === "reasoning" && typeof entry.payload === "object" && entry.payload) || nestedType === "reasoning") {
        const payload = entryType === "reasoning"
          ? entry.payload as Record<string, unknown>
          : (nestedPayload as Record<string, unknown>);
        const reasoningSummary = this.extractReasoningSummary(payload);
        if (reasoningSummary) {
          lastReasoningSummary = reasoningSummary;
          if (!summary) {
            summary = reasoningSummary;
          }
          lastContentIndex = lineIndex;
          if (status === "ended") {
            status = "active";
          }
        }
      }

      const tokenPayload = entryType === "event_msg" ? nestedPayload : undefined;
      if (nestedType === "token_count" && typeof tokenPayload?.info === "object" && tokenPayload.info) {
        const info = tokenPayload.info as Record<string, unknown>;
        if (typeof info.total_token_usage === "object" && info.total_token_usage) {
          const usage = info.total_token_usage as Record<string, unknown>;
          const value = usage.total_tokens;
          if (typeof value === "number") {
            totalTokens = value;
          }
        }
      }
    }

    const latestPendingApproval = Array.from(pendingApprovalRequests.values()).at(-1);

    if (!sessionId) {
      return undefined;
    }

    if (lastTaskCompletedIndex > lastTaskStartedIndex && lastContentIndex <= lastTaskCompletedIndex) {
      status = "ended";
    } else if (lastContentIndex > lastTaskCompletedIndex || taskStartedCount > taskCompletedCount) {
      status = "active";
    }

    return {
      id: sessionId,
      source_path: filePath,
      project_path: cwd,
      title: title ?? basename(filePath),
      summary: summary ?? lastReasoningSummary ?? lastUserMessage,
      source_type: "codex-session-file",
      status,
      updated_at: lastObservedTimestamp ?? stats.mtime.toISOString(),
      metadata: {
        lines: lines.length,
        raw_user_input: lastUserMessage,
        last_user_message: lastUserMessage,
        last_agent_message: lastAgentMessage,
        last_reasoning_summary: lastReasoningSummary,
        raw_agent_response: lastAgentMessage,
        changed_files: filesModified.size > 0 ? Array.from(filesModified) : undefined,
        task_started_count: taskStartedCount,
        task_completed_count: taskCompletedCount,
        user_message_count: userMessageCount,
        agent_message_count: agentMessageCount,
        total_tokens: totalTokens,
        pending_observed_review: latestPendingApproval,
      },
    };
  }

  private readCodexSessionLines(filePath: string, sizeBytes: number): string[] {
    if (sizeBytes <= MAX_FULL_CODEX_SESSION_BYTES) {
      return readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    }

    const fd = openSync(filePath, "r");
    try {
      const headBytes = Math.min(sizeBytes, CODEX_SESSION_HEAD_BYTES);
      const tailBytes = Math.min(sizeBytes, CODEX_SESSION_TAIL_BYTES);
      const head = this.readUtf8Slice(fd, 0, headBytes);
      const tailStart = Math.max(0, sizeBytes - tailBytes);
      const tail = tailStart > 0 ? this.readUtf8Slice(fd, tailStart, tailBytes) : "";

      const headLines = head.split("\n").filter(Boolean);
      const tailLines = tail.split("\n").filter(Boolean);
      const merged = tailStart > 0
        ? [...headLines, ...tailLines]
        : headLines;

      return merged;
    } finally {
      closeSync(fd);
    }
  }

  private readUtf8Slice(fd: number, position: number, length: number): string {
    if (length <= 0) {
      return "";
    }

    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString("utf8");
  }

  private extractObservedTimestamp(entry: Record<string, unknown>): string | undefined {
    const timestamp = this.pickString(entry.timestamp);
    if (!timestamp) {
      return undefined;
    }

    return Number.isNaN(Date.parse(timestamp)) ? undefined : timestamp;
  }

  private extractMessageText(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }

    const objectPayload = payload as Record<string, unknown>;
    const direct = this.pickString(objectPayload.message, objectPayload.text);
    if (direct) {
      return this.sanitizeImportedMessageText(direct);
    }

    if (Array.isArray(objectPayload.content)) {
      const textParts = objectPayload.content
        .map((item) => {
          if (!item || typeof item !== "object") {
            return undefined;
          }

          const contentItem = item as Record<string, unknown>;
          return this.pickString(contentItem.text, contentItem.output_text);
        })
        .filter((value): value is string => Boolean(value));

      if (textParts.length > 0) {
        return this.sanitizeImportedMessageText(textParts.join("\n"));
      }
    }

    return undefined;
  }

  private sanitizeImportedMessageText(text: string): string | undefined {
    const stripped = text
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
      .replace(/\r/g, "")
      .trim();

    return stripped || undefined;
  }

  private isManagedHandoffRelayPrompt(text: string): boolean {
    return /^Buddy managed handoff update for the observed thread\./i.test(text.trim());
  }

  private extractChangedFilePaths(entry: Record<string, unknown>, nestedPayload?: Record<string, unknown>): string[] {
    const payloadCandidates = [entry.payload, nestedPayload];
    const files = new Set<string>();

    for (const candidate of payloadCandidates) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }

      const objectPayload = candidate as Record<string, unknown>;
      if (Array.isArray(objectPayload.files)) {
        for (const file of objectPayload.files) {
          if (!file || typeof file !== "object") {
            continue;
          }
          const path = this.pickString((file as Record<string, unknown>).path, (file as Record<string, unknown>).file_path);
          if (path) {
            files.add(path);
          }
        }
      }

      const directPath = this.pickString(objectPayload.path, objectPayload.file_path);
      if (directPath) {
        files.add(directPath);
      }
    }

    return Array.from(files);
  }

  private extractReasoningSummary(payload: Record<string, unknown>): string | undefined {
    if (Array.isArray(payload.summary)) {
      const text = payload.summary
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

      if (text) {
        return text;
      }
    }

    return this.pickString(payload.content, payload.encrypted_content);
  }

  private buildContinuationSummary(record: RecentWorkRecord): string {
    const parts: string[] = [];

    if (record.summary) {
      parts.push(`Recent summary: ${record.summary}`);
    }

    const metadata = record.metadata ?? {};

    // Claude-specific fields
    const lastUserMessage = this.pickString(metadata.last_user_message);
    const lastAssistantMessage = this.pickString(metadata.last_assistant_message);
    const gitBranch = this.pickString(metadata.git_branch);

    // Codex-specific fields
    const lastAgentMessage = this.pickString(metadata.last_agent_message);
    const lastReasoningSummary = this.pickString(metadata.last_reasoning_summary);

    if (lastUserMessage) {
      parts.push(`Last user request: ${lastUserMessage}`);
    }

    if (lastAssistantMessage) {
      parts.push(`Last assistant update: ${lastAssistantMessage}`);
    }

    if (lastAgentMessage && lastAgentMessage !== lastAssistantMessage) {
      parts.push(`Last agent update: ${lastAgentMessage}`);
    }

    if (lastReasoningSummary) {
      parts.push(`Last reasoning summary: ${lastReasoningSummary}`);
    }

    if (gitBranch) {
      parts.push(`Git branch: ${gitBranch}`);
    }

    return parts.join(" ");
  }

  private inferFocusFiles(record: RecentWorkRecord): string[] | undefined {
    const metadata = record.metadata ?? {};

    // Claude sessions track files_modified from tool uses
    const filesModified = Array.isArray(metadata.files_modified)
      ? metadata.files_modified.filter((f): f is string => typeof f === "string")
      : [];

    const focusCandidates = [
      ...filesModified,
      record.project_path,
      this.pickString(metadata.source_path),
      record.source_path,
    ].filter((value): value is string => Boolean(value));

    const unique = Array.from(new Set(focusCandidates));
    return unique.length > 0 ? unique : undefined;
  }

  private parseCodexActivity(filePath: string, sessionId: string, limit?: number, compact = true): ActivityRecord[] {
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const events: ActivityRecord[] = [];
    const pendingCommands = new Map<string, PendingCodexCommand>();
    let syntheticId = 1;

    for (const line of lines) {
      const entry = parseJsonSafe<Record<string, unknown>>(line, {});
      const timestamp = this.pickString(entry.timestamp) ?? nowIso();
      const payloads = this.mapCodexEntryToActivity(entry, pendingCommands);
      if (payloads.length === 0) {
        continue;
      }

      for (const payload of payloads) {
        events.push({
          id: syntheticId,
          session_id: sessionId,
          created_at: timestamp,
          payload,
        });
        syntheticId += 1;
      }
    }

    const collected = compact ? this.condenseImportedActivity(events) : events;
    const ordered = collected.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return typeof limit === "number" ? ordered.slice(0, limit) : ordered;
  }

  private condenseImportedActivity(events: ActivityRecord[]): ActivityRecord[] {
    if (events.length <= 1) {
      return events;
    }

    const ordered = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
    const condensed: ActivityRecord[] = [];
    let nextId = 1;

    const pushEvent = (event: ActivityRecord) => {
      condensed.push({
        ...event,
        id: nextId,
      });
      nextId += 1;
    };

    let index = 0;
    while (index < ordered.length) {
      const current = ordered[index]!;
      const last = condensed[condensed.length - 1];

      if (this.canMergeStateChange(last, current)) {
        last.payload = current.payload;
        last.created_at = current.created_at;
        index += 1;
        continue;
      }

      if (this.canMergeAgentThinking(last, current)) {
        const previousSummary = (last.payload as Extract<ActivityPayload, { type: "agent_thinking" }>).summary;
        const nextSummary = (current.payload as Extract<ActivityPayload, { type: "agent_thinking" }>).summary;
        if (!previousSummary.includes(nextSummary)) {
          (last.payload as Extract<ActivityPayload, { type: "agent_thinking" }>).summary = `${previousSummary}\n\n${nextSummary}`;
        }
        last.created_at = current.created_at;
        index += 1;
        continue;
      }

      if (this.isDuplicateModelCall(last, current)) {
        index += 1;
        continue;
      }

      const fileBatch = this.collectFileBatch(ordered, index);
      if (fileBatch) {
        pushEvent(fileBatch.event);
        index = fileBatch.nextIndex;
        continue;
      }

      pushEvent({ ...current });
      index += 1;
    }

    return condensed;
  }

  private canMergeStateChange(previous: ActivityRecord | undefined, next: ActivityRecord): boolean {
    return previous?.payload.type === "session_state_change"
      && next.payload.type === "session_state_change"
      && previous.payload.to === next.payload.to;
  }

  private canMergeAgentThinking(previous: ActivityRecord | undefined, next: ActivityRecord): boolean {
    if (previous?.payload.type !== "agent_thinking" || next.payload.type !== "agent_thinking") {
      return false;
    }

    const timeDelta = Date.parse(next.created_at) - Date.parse(previous.created_at);
    return Number.isFinite(timeDelta) && timeDelta >= 0 && timeDelta <= 30_000;
  }

  private isDuplicateModelCall(previous: ActivityRecord | undefined, next: ActivityRecord): boolean {
    if (previous?.payload.type !== "model_call" || next.payload.type !== "model_call") {
      return false;
    }

    return previous.payload.model === next.payload.model
      && previous.payload.tokens_in === next.payload.tokens_in
      && previous.payload.tokens_out === next.payload.tokens_out
      && previous.payload.cost_usd === next.payload.cost_usd;
  }

  private collectFileBatch(
    events: ActivityRecord[],
    startIndex: number,
  ): { event: ActivityRecord; nextIndex: number } | undefined {
    const first = events[startIndex];
    if (!first || !this.isFileActivity(first.payload)) {
      return undefined;
    }

    const files: Extract<ActivityPayload, { type: "file_batch" }>["files"] = [];
    let cursor = startIndex;
    while (cursor < events.length) {
      const event = events[cursor]!;
      if (event.created_at !== first.created_at || !this.isFileActivity(event.payload)) {
        break;
      }

      if (event.payload.type === "file_edit") {
        files.push({
          path: event.payload.path,
          action: "edited",
          lines_added: event.payload.lines_added,
          lines_removed: event.payload.lines_removed,
        });
      } else if (event.payload.type === "file_create") {
        files.push({
          path: event.payload.path,
          action: "created",
        });
      } else if (event.payload.type === "file_delete") {
        files.push({
          path: event.payload.path,
          action: "deleted",
        });
      }
      cursor += 1;
    }

    if (files.length < 2) {
      return undefined;
    }

    return {
      event: {
        id: first.id,
        session_id: first.session_id,
        created_at: first.created_at,
        payload: {
          type: "file_batch",
          summary: this.buildFileBatchSummary(files),
          files,
        },
      },
      nextIndex: cursor,
    };
  }

  private isFileActivity(
    payload: ActivityPayload,
  ): payload is Extract<ActivityPayload, { type: "file_edit" | "file_create" | "file_delete" }> {
    return payload.type === "file_edit" || payload.type === "file_create" || payload.type === "file_delete";
  }

  private buildFileBatchSummary(files: Extract<ActivityPayload, { type: "file_batch" }>["files"]): string {
    const created = files.filter((file) => file.action === "created").length;
    const deleted = files.filter((file) => file.action === "deleted").length;
    const edited = files.filter((file) => file.action === "edited").length;
    const parts = [
      edited > 0 ? `${edited} edited` : undefined,
      created > 0 ? `${created} created` : undefined,
      deleted > 0 ? `${deleted} deleted` : undefined,
    ].filter((value): value is string => Boolean(value));
    return `Updated files: ${parts.join(", ")}`;
  }

  private filterActivityByType(
    events: ActivityRecord[],
    types?: ActivityPayload["type"][],
  ): ActivityRecord[] {
    if (!types || types.length === 0) {
      return events;
    }

    const allowed = new Set(types);
    return events.filter((event) => allowed.has(event.payload.type));
  }

  private mapCodexEntryToActivity(
    entry: Record<string, unknown>,
    pendingCommands: Map<string, PendingCodexCommand>,
  ): ActivityPayload[] {
    const entryType = this.pickString(entry.type);
    const nestedPayload = this.getNestedCodexPayload(entry);
    const nestedType = this.pickString(nestedPayload?.type);
    const messageRole = this.pickString(nestedPayload?.role);
    const isUserMessage = entryType === "user_message" || nestedType === "user_message" || (entryType === "response_item" && nestedType === "message" && messageRole === "user");
    const isAgentMessage = entryType === "agent_message" || nestedType === "agent_message" || (entryType === "response_item" && nestedType === "message" && messageRole === "assistant");

    if (entryType === "session_meta") {
      return [{
        type: "session_state_change",
        from: "unknown",
        to: "idle",
      }];
    }

    if (entryType === "task_started" || nestedType === "task_started") {
      return [{
        type: "session_state_change",
        from: "idle",
        to: "working",
      }];
    }

    if (entryType === "task_complete" || nestedType === "task_complete") {
      return [{
        type: "session_state_change",
        from: "working",
        to: "completed",
      }];
    }

    if (isUserMessage) {
      const message = this.extractMessageText(entryType === "user_message" ? entry.payload : nestedPayload);
      return message
        ? [{
            type: "agent_thinking",
            summary: `User request: ${message}`,
          }]
        : [];
    }

    if (isAgentMessage) {
      const message = this.extractMessageText(entryType === "agent_message" ? entry.payload : nestedPayload);
      return message
        ? [{
            type: "agent_thinking",
            summary: message,
          }]
        : [];
    }

    if (entryType === "reasoning" || nestedType === "reasoning") {
      const reasoningPayload = entryType === "reasoning"
        ? entry.payload as Record<string, unknown>
        : nestedPayload as Record<string, unknown>;
      const summary = this.extractReasoningSummary(reasoningPayload);
      return summary
        ? [{
            type: "agent_thinking",
            summary,
          }]
        : [];
    }

    if (nestedType === "context_compacted") {
      return [{
        type: "agent_thinking",
        summary: "Context compacted for the ongoing session.",
      }];
    }

    if (entryType === "response_item" && nestedType === "function_call" && nestedPayload) {
      this.registerCodexCommandCall(nestedPayload, pendingCommands);
      return this.toObservedApprovalPayload(nestedPayload)
        ? [this.toObservedApprovalPayload(nestedPayload)!]
        : [];
    }

    if (entryType === "response_item" && nestedType === "custom_tool_call" && nestedPayload) {
      this.registerCodexCommandCall(nestedPayload, pendingCommands);
      return this.toObservedApprovalPayload(nestedPayload)
        ? [this.toObservedApprovalPayload(nestedPayload)!]
        : [];
    }

    if (entryType === "response_item" && (nestedType === "function_call_output" || nestedType === "custom_tool_call_output") && nestedPayload) {
      return this.buildCodexCommandActivity(nestedPayload, pendingCommands);
    }

    if (nestedType === "token_count" && typeof nestedPayload?.info === "object" && nestedPayload.info) {
      const info = nestedPayload.info as Record<string, unknown>;
      if (typeof info.total_token_usage === "object" && info.total_token_usage) {
        const usage = info.total_token_usage as Record<string, unknown>;
        const model = this.pickString(usage.model, info.model) ?? "unknown";
        const tokensIn = Number(usage.input_tokens ?? usage.input ?? 0);
        const tokensOut = Number(usage.output_tokens ?? usage.output ?? 0);
        const reasoningTokens = Number(usage.reasoning_output_tokens ?? 0);
        return [{
          type: "model_call",
          model,
          tokens_in: tokensIn,
          tokens_out: tokensOut + reasoningTokens,
          cost_usd: Number(usage.cost_usd ?? 0),
        }];
      }
    }

    return [];
  }

  private getNestedCodexPayload(entry: Record<string, unknown>): Record<string, unknown> | undefined {
    if (typeof entry.payload === "object" && entry.payload) {
      return entry.payload as Record<string, unknown>;
    }

    if (typeof entry.item === "object" && entry.item) {
      return entry.item as Record<string, unknown>;
    }

    return undefined;
  }

  private registerCodexCommandCall(
    payload: Record<string, unknown>,
    pendingCommands: Map<string, PendingCodexCommand>,
  ): void {
    const callId = this.pickString(payload.call_id);
    if (!callId) {
      return;
    }

    pendingCommands.set(callId, {
      cmd: this.describeCodexCommand(payload),
      sideEffects: this.extractCodexSideEffects(payload),
      approvalRequest: this.toObservedApprovalPayload(payload),
    });
  }

  private buildCodexCommandActivity(
    payload: Record<string, unknown>,
    pendingCommands: Map<string, PendingCodexCommand>,
  ): ActivityPayload[] {
    const callId = this.pickString(payload.call_id);
    if (!callId) {
      return [];
    }

    const pending = pendingCommands.get(callId);
    pendingCommands.delete(callId);

    const output = this.pickString(payload.output);
    const parsedCustomOutput = this.parseJsonIfObject(output);
    const customMetadata = parsedCustomOutput && typeof parsedCustomOutput.metadata === "object"
      ? parsedCustomOutput.metadata as Record<string, unknown>
      : undefined;
    const stdoutPreview = this.pickString(
      parsedCustomOutput?.output,
      this.extractCommandOutputPreview(output),
    );
    const command = pending?.cmd ?? "unknown";
    const durationMs = this.extractCommandDurationMs(output, customMetadata);
    const commandEvents: ActivityPayload[] = [{
      type: "command_run",
      cmd: command,
      exit_code: this.extractCommandExitCode(output, customMetadata),
      duration_ms: durationMs,
      stdout_preview: stdoutPreview,
    }];
    if (pending?.approvalRequest) {
      commandEvents.unshift({
        type: "approval_resolved",
        action: pending.approvalRequest.action,
        decision: "approved",
      });
    }
    const testRun = this.extractTestRunActivity(command, output, stdoutPreview, durationMs);
    if (testRun) {
      commandEvents.push(testRun);
    }

    return [...commandEvents, ...(pending?.sideEffects ?? [])];
  }

  private describeCodexCommand(payload: Record<string, unknown>): string {
    const toolType = this.pickString(payload.type);
    const name = this.pickString(payload.name) ?? "unknown";
    if (toolType === "function_call") {
      const args = this.parseJsonIfObject(this.pickString(payload.arguments));
      const command = args && typeof args.cmd === "string" && args.cmd.trim() ? args.cmd.trim() : undefined;
      return command ?? `tool:${name}`;
    }

    const input = this.pickString(payload.input);
    if (!input) {
      return `tool:${name}`;
    }

    const firstLine = input.split("\n")[0]?.trim();
    if (!firstLine) {
      return `tool:${name}`;
    }

    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  }

  private parseJsonIfObject(text: string | undefined): Record<string, unknown> | undefined {
    if (!text) {
      return undefined;
    }

    const trimmed = text.trim();
    if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      return undefined;
    }

    const parsed = parseJsonSafe<Record<string, unknown> | undefined>(trimmed, undefined);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  }

  private extractCodexSideEffects(payload: Record<string, unknown>): ActivityPayload[] {
    if (this.pickString(payload.name) !== "apply_patch") {
      return [];
    }

    const input = this.pickString(payload.input);
    if (!input) {
      return [];
    }

    return this.parseApplyPatchSideEffects(input);
  }

  private toObservedApprovalPayload(payload: Record<string, unknown>): Extract<ActivityPayload, { type: "approval_requested" }> | undefined {
    const approvalRequest = this.extractCodexApprovalRequest(payload);
    if (!approvalRequest) {
      return undefined;
    }

    return {
      type: "approval_requested",
      action: approvalRequest.action,
      context: approvalRequest.context,
    };
  }

  private extractCodexApprovalRequest(payload: Record<string, unknown>): {
    action: string;
    context: string;
    cmd?: string;
    success_checks?: TakeoverSuccessCheck[];
  } | undefined {
    if (this.pickString(payload.name) !== "exec_command") {
      return undefined;
    }

    const parsedArguments = this.parseJsonIfObject(this.pickString(payload.arguments));
    const customToolPayload = this.pickString(payload.input)
      ? parseJsonSafe<Record<string, unknown> | undefined>(this.pickString(payload.input), undefined)
      : undefined;
    const argumentsPayload = parsedArguments ?? customToolPayload;
    if (!argumentsPayload || this.pickString(argumentsPayload.sandbox_permissions) !== "require_escalated") {
      return undefined;
    }

    const command = this.pickString(argumentsPayload.cmd);
    const justification = this.pickString(argumentsPayload.justification);
    const actionTarget = command ?? "run an escalated command";
    const compactActionTarget = actionTarget.length > 96
      ? `${actionTarget.slice(0, 95).trimEnd()}…`
      : actionTarget;

    return {
      action: `Approve command: ${compactActionTarget}`,
      context: justification ?? `Approval is required before running: ${actionTarget}`,
      cmd: command,
      success_checks: this.inferSuccessChecks(command),
    };
  }

  private pickObservedTakeover(record: RecentWorkRecord): ObservedTakeoverContext | undefined {
    const pending = record.metadata?.pending_observed_review;
    if (!pending || typeof pending !== "object") {
      return undefined;
    }

    const objectPending = pending as Record<string, unknown>;
    const action = this.pickString(objectPending.action);
    const context = this.pickString(objectPending.context);
    if (!action || !context) {
      return undefined;
    }

    const successChecks = Array.isArray(objectPending.success_checks)
      ? objectPending.success_checks
        .map((item) => this.toSuccessCheck(item))
        .filter((item): item is TakeoverSuccessCheck => Boolean(item))
      : [];

    return {
      action,
      context,
      cmd: this.pickString(objectPending.cmd),
      detected_at: this.pickString(objectPending.detected_at),
      success_checks: successChecks.length > 0 ? successChecks : undefined,
    };
  }

  private toSuccessCheck(value: unknown): TakeoverSuccessCheck | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const objectValue = value as Record<string, unknown>;
    const kind = this.pickString(objectValue.kind);
    if (kind !== "path_exists" && kind !== "command_exit_zero") {
      return undefined;
    }

    return {
      kind,
      path: this.pickString(objectValue.path),
      path_type: this.pickString(objectValue.path_type) as TakeoverSuccessCheck["path_type"] | undefined,
      cmd: this.pickString(objectValue.cmd),
    };
  }

  private inferSuccessChecks(command: string | undefined): TakeoverSuccessCheck[] | undefined {
    const normalized = command?.trim();
    if (!normalized) {
      return undefined;
    }

    const checks: TakeoverSuccessCheck[] = [{
      kind: "command_exit_zero",
      cmd: normalized,
    }];

    const targetPath = this.inferTargetPath(normalized);
    if (targetPath) {
      checks.push({
        kind: "path_exists",
        path: targetPath.path,
        path_type: targetPath.pathType,
      });
    }

    return checks;
  }

  private inferTargetPath(command: string): { path: string; pathType: "file" | "directory" | "any" } | undefined {
    const tokens = this.tokenizeShellWords(command);
    if (tokens.length < 2) {
      return undefined;
    }

    const executable = basename(tokens[0] ?? "").toLowerCase();
    const positional = tokens.slice(1).filter((token) => !token.startsWith("-"));
    const target = positional.at(-1);
    if (!target) {
      return undefined;
    }

    const resolvedTarget = this.normalizeShellPath(target);
    if (!resolvedTarget) {
      return undefined;
    }

    if (["cp", "mv", "touch", "install", "ln", "rsync", "dd"].includes(executable)) {
      return { path: resolvedTarget, pathType: "file" };
    }

    if (executable === "mkdir") {
      return { path: resolvedTarget, pathType: "directory" };
    }

    return undefined;
  }

  private tokenizeShellWords(command: string): string[] {
    const matches = command.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\\.|[^\s]+/g) ?? [];
    return matches
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => {
        if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
          return token.slice(1, -1);
        }

        return token.replace(/\\([\\ "'`$])/g, "$1");
      });
  }

  private normalizeShellPath(candidate: string): string | undefined {
    if (!candidate || candidate === "-" || candidate.startsWith("|")) {
      return undefined;
    }

    if (candidate.startsWith("~/")) {
      const home = process.env.HOME ?? "";
      return home ? join(home, candidate.slice(2)) : undefined;
    }

    return isAbsolute(candidate) ? candidate : undefined;
  }

  private parseApplyPatchSideEffects(input: string): ActivityPayload[] {
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
        current = {
          kind: "file_edit",
          path: line.slice("*** Update File: ".length).trim(),
          linesAdded: 0,
          linesRemoved: 0,
        };
        continue;
      }

      if (line.startsWith("*** Add File: ")) {
        flush();
        current = {
          kind: "file_create",
          path: line.slice("*** Add File: ".length).trim(),
          linesAdded: 0,
          linesRemoved: 0,
        };
        continue;
      }

      if (line.startsWith("*** Delete File: ")) {
        flush();
        current = {
          kind: "file_delete",
          path: line.slice("*** Delete File: ".length).trim(),
          linesAdded: 0,
          linesRemoved: 0,
        };
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

  private extractTestRunActivity(
    command: string,
    rawOutput: string | undefined,
    stdoutPreview: string | undefined,
    durationMs: number,
  ): ActivityPayload | undefined {
    if (!this.looksLikeTestCommand(command)) {
      return undefined;
    }

    const output = [stdoutPreview, rawOutput].filter((value): value is string => Boolean(value)).join("\n");
    const passed = this.pickNumericPattern(output, [
      /ℹ pass (\d+)/i,
      /\b(\d+)\s+passed\b/i,
      /\bpassed:\s*(\d+)\b/i,
    ]);
    const failed = this.pickNumericPattern(output, [
      /ℹ fail (\d+)/i,
      /\b(\d+)\s+failed\b/i,
      /\bfailed:\s*(\d+)\b/i,
    ]);
    const skipped = this.pickNumericPattern(output, [
      /ℹ skipped (\d+)/i,
      /\b(\d+)\s+skipped\b/i,
      /\bskipped:\s*(\d+)\b/i,
    ]);

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

  private looksLikeTestCommand(command: string): boolean {
    return /\b(test|vitest|jest|pytest|mocha|ava)\b/i.test(command)
      || /\b(cargo|go|pnpm|npm|bun|yarn)\s+test\b/i.test(command);
  }

  private pickNumericPattern(text: string, patterns: RegExp[]): number | undefined {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        return Number(match[1]);
      }
    }

    return undefined;
  }

  private extractCommandExitCode(
    output: string | undefined,
    metadata?: Record<string, unknown>,
  ): number {
    if (typeof metadata?.exit_code === "number") {
      return metadata.exit_code;
    }

    const match = output?.match(/Process exited with code (\d+)/);
    return match ? Number(match[1]) : 0;
  }

  private extractCommandDurationMs(
    output: string | undefined,
    metadata?: Record<string, unknown>,
  ): number {
    if (typeof metadata?.duration_seconds === "number") {
      return Math.round(metadata.duration_seconds * 1000);
    }

    const match = output?.match(/Wall time:\s*([\d.]+)\s*seconds/);
    return match ? Math.round(Number(match[1]) * 1000) : 0;
  }

  private extractCommandOutputPreview(output: string | undefined): string | undefined {
    if (!output) {
      return undefined;
    }

    const marker = "Output:\n";
    const markerIndex = output.indexOf(marker);
    if (markerIndex >= 0) {
      const text = output.slice(markerIndex + marker.length).trim();
      return text || undefined;
    }

    const compact = output.trim();
    return compact ? compact.slice(0, 400) : undefined;
  }
}
