import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer as createHttpListener, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsListener, type Server as HttpsServer } from "node:https";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import type { DaemonConfig } from "../domain.ts";
import { AsynqAgentdStorage } from "../db/storage.ts";
import { SessionService } from "../services/session-service.ts";
import { TaskService, type CreateTaskInput } from "../services/task-service.ts";
import { ConfigService } from "../services/config-service.ts";
import { SchedulerService } from "../services/scheduler.ts";
import { RecentWorkService } from "../services/recent-work-service.ts";
import { EventStreamService } from "../services/event-stream-service.ts";
import { TerminalStreamService } from "../services/terminal-stream-service.ts";
import { DashboardService } from "../services/dashboard-service.ts";
import { UpdateService } from "../services/update-service.ts";
import { normalizeResolutionStrategy, parseObservedApprovalId, type ObservedResolutionStrategy, type ResolveObservedApprovalInput, type ObservedResolutionService } from "../services/observed-resolution-service.ts";
import { createWebSocketAccept, encodeWebSocketPongFrame, encodeWebSocketTextFrame, parseWebSocketFrames } from "../utils/websocket.ts";
import { AGENTD_VERSION } from "../version.ts";

interface AppServices {
  storage: AsynqAgentdStorage;
  tasks: TaskService;
  sessions: SessionService;
  config: ConfigService;
  scheduler: SchedulerService;
  recentWork: RecentWorkService;
  liveEvents: EventStreamService;
  terminalStreams: TerminalStreamService;
  dashboard: DashboardService;
  updates: UpdateService;
  observedResolution: ObservedResolutionService;
}

interface TerminalControlMessage {
  type: "send_message" | "stdin" | "resize" | "stop";
  message?: string;
  data?: string;
  cols?: number;
  rows?: number;
}

interface AnalyticsEventInput {
  name?: string;
  source?: "mobile";
  created_at?: string;
  properties?: Record<string, unknown>;
}

interface MarkdownExportInput {
  title?: string;
  content?: string;
  project_path?: string;
}

interface OpenExportInput {
  path?: string;
  reveal?: boolean;
}

function isPublicRoute(method: string, path: string): boolean {
  return method === "GET" && (path === "/" || path === "/health");
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header) {
    return false;
  }

  const expected = `Bearer ${token}`;
  return header === expected;
}

function isAuthorizedWebSocket(req: IncomingMessage, url: URL, token: string): boolean {
  return isAuthorized(req, token) || url.searchParams.get("token") === token;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sanitizeDebugValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > 800) {
      return `${value.slice(0, 800)}… [truncated ${value.length - 800} chars]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeDebugValue(item));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 40).map(([key, entryValue]) => [
      key,
      key.toLowerCase().includes("token") ? "[redacted]" : sanitizeDebugValue(entryValue),
    ]);
    return Object.fromEntries(entries);
  }

  return value;
}

function debugHttpLog(method: string, path: string, status: number, requestPayload?: unknown, responsePayload?: unknown): void {
  const enabled = process.env.ASYNQ_AGENTD_DEBUG_HTTP !== "0";
  if (!enabled) {
    return;
  }

  const lines = [
    `[http] ${method} ${path} -> ${status}`,
    requestPayload === undefined
      ? "request: <empty>"
      : `request: ${JSON.stringify(sanitizeDebugValue(requestPayload), null, 2)}`,
    responsePayload === undefined
      ? "response: <empty>"
      : `response: ${JSON.stringify(sanitizeDebugValue(responsePayload), null, 2)}`,
  ];
  console.log(lines.join("\n"));
}

function beginSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
}

function sendSse(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseCompactParam(value: string | null): boolean {
  if (!value) {
    return true;
  }

  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function parseOptionalBooleanParam(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function parsePositiveInt(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function parseCsvParam(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "Not found" });
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return undefined;
}

function pickResumeSessionId(session: ReturnType<SessionService["getRecord"]>, task: ReturnType<TaskService["get"]>) {
  if (!session) {
    return undefined;
  }

  return pickString(
    session.metadata?.codex_session_id,
    session.metadata?.claude_session_id,
    session.metadata?.codex_resume_session_id,
    session.metadata?.claude_resume_session_id,
    task?.context?.previous_session_id,
  );
}

export function pickSourceCodexSessionId(
  task: ReturnType<TaskService["get"]>,
  sourceRecentWork?: {
    id: string;
    source_type: string;
  },
) {
  return pickString(
    task?.context?.source_codex_session_id,
    sourceRecentWork?.source_type.startsWith("codex") ? sourceRecentWork.id : undefined,
  );
}

function buildContinuationDescription(
  session: ReturnType<SessionService["get"]> | ReturnType<SessionService["getRecord"]>,
  message?: string,
  sourceRecentWork?: {
    title: string;
    summary?: string;
    updated_at?: string;
  },
) {
  const parts = ["Continue the managed session from its latest completed state."];

  const priorOutput = extractLatestManagedOutput(session);
  if (priorOutput) {
    parts.push(`Most recent managed output: ${priorOutput}`);
    parts.push("Preserve established decisions from the prior managed session unless the operator explicitly changes them.");
  }

  if (sourceRecentWork?.title) {
    parts.push(`Observed upstream: ${sourceRecentWork.title}.`);
  }

  if (sourceRecentWork?.summary) {
    parts.push(`Latest observed summary: ${sourceRecentWork.summary}`);
  }

  if (sourceRecentWork?.updated_at) {
    parts.push(`Observed last active at: ${sourceRecentWork.updated_at}.`);
  }

  const instruction = message?.trim();
  if (instruction) {
    parts.push(`Operator instruction: ${instruction}`);
  }

  if (!instruction) {
    parts.push("Keep making progress.");
  }

  return parts.join(" ");
}

function extractLatestManagedOutput(
  session: ReturnType<SessionService["get"]> | ReturnType<SessionService["getRecord"]>,
): string | undefined {
  if (!session || !("recent_events" in session) || !Array.isArray(session.recent_events)) {
    return undefined;
  }

  for (const event of session.recent_events) {
    const payload = event.payload;
    if (payload.type === "agent_output" && typeof payload.message === "string" && payload.message.trim()) {
      return compactContinuationText(payload.message);
    }
    if (payload.type === "agent_thinking" && typeof payload.summary === "string" && payload.summary.trim()) {
      return compactContinuationText(payload.summary);
    }
    if (payload.type === "approval_requested" && typeof payload.context === "string" && payload.context.trim()) {
      return compactContinuationText(payload.context);
    }
  }

  return undefined;
}

function compactContinuationText(text: string, maxLength = 480): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function sanitizeFileSlug(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .toLowerCase()
    .slice(0, 64) || "managed-output";
}

function formatExportTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
}

function ensureExportsGitignored(projectPath: string): void {
  const gitignorePath = resolve(projectPath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return;
  }

  const current = readFileSync(gitignorePath, "utf8");
  const normalizedEntries = current
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\/+/, ""));
  if (normalizedEntries.includes(".asynq-exports") || normalizedEntries.includes(".asynq-exports/")) {
    return;
  }

  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  const next = `${current}${separator}.asynq-exports/\n`;
  writeFileSync(gitignorePath, next, "utf8");
}

function writeMarkdownExport(projectPath: string, title: string, content: string): { path: string; bytes: number } {
  const exportDir = resolve(projectPath, ".asynq-exports");
  mkdirSync(exportDir, { recursive: true });
  ensureExportsGitignored(projectPath);
  const now = new Date();
  const filePath = resolve(exportDir, `${sanitizeFileSlug(title)}-${formatExportTimestamp(now)}.md`);
  const heading = title.trim() || "Managed output";
  const payload = `# ${heading}\n\nGenerated: ${now.toISOString()}\nProject: ${projectPath}\n\n---\n\n${content.trim()}\n`;
  writeFileSync(filePath, payload, "utf8");
  return {
    path: filePath,
    bytes: Buffer.byteLength(payload, "utf8"),
  };
}

function isExportPathAllowed(absolutePath: string): boolean {
  return absolutePath.includes("/.asynq-exports/") && absolutePath.endsWith(".md");
}

function openFileOnHost(path: string, reveal = false): void {
  const args = reveal ? ["-R", path] : [path];
  const child = spawn("open", args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function parseTerminalControlMessage(payload: string): TerminalControlMessage {
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  if (parsed.type === "send_message" && typeof parsed.message === "string" && parsed.message.trim()) {
    return {
      type: "send_message",
      message: parsed.message,
    };
  }

  if (parsed.type === "stdin" && typeof parsed.data === "string" && parsed.data.length > 0) {
    return {
      type: "stdin",
      data: parsed.data,
    };
  }

  if (
    parsed.type === "resize"
    && Number.isInteger(parsed.cols)
    && Number.isInteger(parsed.rows)
    && Number(parsed.cols) > 0
    && Number(parsed.rows) > 0
  ) {
    return {
      type: "resize",
      cols: Number(parsed.cols),
      rows: Number(parsed.rows),
    };
  }

  if (parsed.type === "stop") {
    return { type: "stop" };
  }

  throw new Error("Unsupported terminal control message");
}

type TlsServerOptions = {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
};

export function createDaemonServer(services: AppServices, tls: TlsServerOptions): HttpServer | HttpsServer {
  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || !req.method) {
      notFound(res);
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method.toUpperCase();
    const clientAppVersion = pickString(req.headers["x-asynq-buddy-version"]);
    const clientMinAgentdVersion = pickString(req.headers["x-asynq-buddy-min-agentd-version"]);
    let requestPayload: unknown;
    const readBody = async <T>() => {
      const body = await readJson<T>(req);
      requestPayload = body;
      return body;
    };
    const send = (status: number, payload: unknown) => {
      debugHttpLog(method, path, status, requestPayload, payload);
      sendJson(res, status, payload);
    };
    const sendNotFound = () => {
      send(404, { error: "Not found" });
    };

    try {
      if (!isPublicRoute(method, path) && !isAuthorized(req, services.config.get().auth_token)) {
        send(401, { error: "Unauthorized" });
        return;
      }

      if (method === "GET" && path === "/health") {
        send(200, { ok: true });
        return;
      }

      if (method === "GET" && path === "/") {
        send(200, {
          name: "asynq-agentd",
          status: "ok",
          version: AGENTD_VERSION,
        });
        return;
      }

      if (method === "GET" && path === "/sessions") {
        send(200, services.sessions.list());
        return;
      }

      if (method === "GET" && path === "/dashboard/overview") {
        send(200, services.dashboard.getOverview({
          app_version: clientAppVersion,
          min_supported_agentd_version: clientMinAgentdVersion,
        }));
        return;
      }

      if (method === "GET" && path === "/dashboard/attention-required") {
        send(200, services.dashboard.getAttentionRequired({
          app_version: clientAppVersion,
          min_supported_agentd_version: clientMinAgentdVersion,
        }));
        return;
      }

      if (method === "GET" && path === "/dashboard/continue-working") {
        send(200, services.dashboard.getContinueWorking());
        return;
      }

      if (method === "GET" && path === "/managed-sessions") {
        send(200, services.dashboard.getManagedSessions());
        return;
      }

      const managedSessionMatch = path.match(/^\/managed-sessions\/([^/]+)$/);
      if (method === "GET" && managedSessionMatch) {
        const detail = services.dashboard.getManagedSessionDetail(managedSessionMatch[1]);
        if (!detail) {
          sendNotFound();
          return;
        }
        send(200, detail);
        return;
      }

      if (method === "DELETE" && managedSessionMatch) {
        send(200, {
          ok: true,
          ...services.tasks.deleteManagedSessionTree(managedSessionMatch[1]),
        });
        return;
      }

      if (method === "GET" && path === "/stream/events") {
        beginSse(res);
        const unsubscribe = services.liveEvents.subscribe((event) => {
          sendSse(res, event.kind, event);
        });
        req.on("close", unsubscribe);
        return;
      }

      const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
      if (method === "GET" && sessionMatch) {
        const detail = services.sessions.get(sessionMatch[1]);
        if (!detail) {
          sendNotFound();
          return;
        }
        send(200, detail);
        return;
      }

      const sessionEventsStreamMatch = path.match(/^\/sessions\/([^/]+)\/events\/stream$/);
      if (method === "GET" && sessionEventsStreamMatch) {
        beginSse(res);
        const unsubscribe = services.liveEvents.subscribe((event) => {
          sendSse(res, event.kind, event);
        }, sessionEventsStreamMatch[1]);
        req.on("close", unsubscribe);
        return;
      }

      const sessionTerminalMatch = path.match(/^\/sessions\/([^/]+)\/terminal$/);
      if (method === "GET" && sessionTerminalMatch) {
        send(200, services.terminalStreams.list(
          sessionTerminalMatch[1],
          parsePositiveInt(url.searchParams.get("limit")) ?? 200,
        ));
        return;
      }

      const sessionMessageMatch = path.match(/^\/sessions\/([^/]+)\/message$/);
      if (method === "POST" && sessionMessageMatch) {
        const body = await readBody<{ message?: string }>();
        const session = services.sessions.getRecord(sessionMessageMatch[1]);
        if (!session) {
          sendNotFound();
          return;
        }

        if (session.state === "working" || session.state === "waiting_approval") {
          services.sessions.sendMessage(session.id, body.message ?? "");
          send(202, { ok: true, mode: "live" });
          return;
        }

        const sessionDetail = services.sessions.get(session.id) ?? session;
        const task = session.task_id ? services.tasks.get(session.task_id) : undefined;
        const sourceRecentWorkId = pickString(
          task?.context?.source_recent_work_id,
          task?.context?.previous_session_id,
        );
        const sourceRecentWork = sourceRecentWorkId ? services.recentWork.get(sourceRecentWorkId) : undefined;
        const continuation = services.tasks.create({
          title: session.title,
          description: buildContinuationDescription(
            sessionDetail,
            body.message,
            sourceRecentWork
              ? {
                  title: sourceRecentWork.title,
                  summary: sourceRecentWork.summary,
                  updated_at: sourceRecentWork.updated_at,
                }
              : undefined,
          ),
          agent_type: session.agent_type,
          project_path: session.project_path,
          branch: session.branch,
          priority: task?.priority,
          approval_required: task?.approval_required,
          model_preference: task?.model_preference,
          context: {
            previous_session_id: pickResumeSessionId(session, task),
            parent_session_id: session.id,
            source_recent_work_id: sourceRecentWork?.id ?? task?.context?.source_recent_work_id,
            source_recent_work_updated_at: sourceRecentWork?.updated_at ?? task?.context?.source_recent_work_updated_at,
            source_codex_session_id: pickSourceCodexSessionId(task, sourceRecentWork),
            observed_takeover: task?.context?.observed_takeover,
            files_to_focus: task?.context?.files_to_focus,
            test_command: task?.context?.test_command,
          },
        });
        void services.scheduler.tick();
        send(202, {
          ok: true,
          mode: "continued",
          task_id: continuation.id,
        });
        return;
      }

      if (method === "DELETE" && sessionMatch) {
        send(200, services.sessions.stop(sessionMatch[1]));
        return;
      }

      if (method === "GET" && path === "/tasks") {
        send(200, services.tasks.list());
        return;
      }

      if (method === "POST" && path === "/tasks") {
        const body = await readBody<CreateTaskInput>();
        const task = services.tasks.create(body);
        void services.scheduler.tick();
        send(201, task);
        return;
      }

      const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
      if (method === "PATCH" && taskMatch) {
        const body = await readBody<Record<string, unknown>>();
        const task = services.tasks.update(taskMatch[1], body);
        void services.scheduler.tick();
        send(200, task);
        return;
      }

      if (method === "DELETE" && taskMatch) {
        send(200, { deleted: services.tasks.delete(taskMatch[1]) });
        return;
      }

      if (method === "GET" && path === "/approvals") {
        const status = url.searchParams.get("status") ?? undefined;
        send(200, services.storage.listApprovals(status as never));
        return;
      }

      if (method === "GET" && path === "/analytics/events") {
        const limit = parsePositiveInt(url.searchParams.get("limit")) ?? 100;
        send(200, {
          generated_at: new Date().toISOString(),
          items: services.storage.listAnalyticsEvents(limit),
        });
        return;
      }

      if (method === "POST" && path === "/analytics/events") {
        const body = await readJson<AnalyticsEventInput>(req);
        const event = services.storage.insertAnalyticsEvent({
          name: pickString(body.name) ?? "unknown",
          source: body.source ?? "mobile",
          created_at: pickString(body.created_at) ?? new Date().toISOString(),
          properties: body.properties ?? {},
        });
        send(201, event);
        return;
      }

      if (method === "GET" && path === "/updates/status") {
        send(200, {
          generated_at: new Date().toISOString(),
          status: services.updates.getStatus(),
          compatibility: services.updates.getCompatibility({
            app_version: clientAppVersion,
            min_supported_agentd_version: clientMinAgentdVersion,
          }),
        });
        return;
      }

      if (method === "POST" && path === "/updates/check") {
        const status = await services.updates.checkNow();
        send(200, {
          ok: true,
          status,
        });
        return;
      }

      if (method === "POST" && path === "/updates/install") {
        const status = await services.updates.installUpdate();
        send(202, {
          ok: true,
          status,
        });
        return;
      }

      if (method === "POST" && path === "/exports/markdown") {
        const body = await readBody<MarkdownExportInput>();
        const content = pickString(body.content);
        if (!content) {
          send(400, { error: "content is required" });
          return;
        }

        const projectPath = pickString(body.project_path);
        if (!projectPath) {
          send(400, { error: "project_path is required" });
          return;
        }

        const resolvedProjectPath = resolve(projectPath);
        if (!existsSync(resolvedProjectPath)) {
          send(400, { error: `project_path does not exist: ${resolvedProjectPath}` });
          return;
        }

        const title = pickString(body.title) ?? "Managed output";
        const result = writeMarkdownExport(resolvedProjectPath, title, content);
        send(201, { ok: true, ...result });
        return;
      }

      if (method === "POST" && path === "/exports/open") {
        const body = await readBody<OpenExportInput>();
        const requestedPath = pickString(body.path);
        if (!requestedPath) {
          send(400, { error: "path is required" });
          return;
        }

        const absolutePath = resolve(requestedPath);
        if (!existsSync(absolutePath)) {
          send(400, { error: `path does not exist: ${absolutePath}` });
          return;
        }
        if (!isExportPathAllowed(absolutePath)) {
          send(400, { error: "path is not an allowed export file" });
          return;
        }

        openFileOnHost(absolutePath, body.reveal !== false);
        send(202, { ok: true, path: absolutePath });
        return;
      }

      const approvalMatch = path.match(/^\/approvals\/([^/]+)$/);
      if (method === "GET" && approvalMatch) {
        const approval = services.dashboard.getApprovalDetail(approvalMatch[1], {
          app_version: clientAppVersion,
          min_supported_agentd_version: clientMinAgentdVersion,
        });
        if (!approval) {
          sendNotFound();
          return;
        }

        send(200, approval);
        return;
      }

      if (method === "POST" && approvalMatch) {
        const body = await readBody<{
          decision: "approved" | "rejected";
          note?: string;
          resolution_strategy?: ObservedResolutionStrategy;
          require_verification?: boolean;
        }>();

        const approvalId = approvalMatch[1];
        const observedRecentWorkId = parseObservedApprovalId(approvalId);
        if (observedRecentWorkId) {
          const strategy = normalizeResolutionStrategy(body.resolution_strategy) ?? "auto";
          const input: ResolveObservedApprovalInput = {
            approvalId,
            decision: body.decision,
            note: body.note,
            resolutionStrategy: strategy,
            requireVerification: body.require_verification !== false,
          };
          send(200, await services.observedResolution.resolve(input));
          return;
        }

        send(200, services.sessions.resolveApproval(approvalId, body.decision, body.note));
        return;
      }

      if (method === "GET" && path === "/activity") {
        const recentWorkId = url.searchParams.get("recent_work");
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
        if (recentWorkId) {
          send(200, services.recentWork.listImportedActivity(
            recentWorkId,
            limit,
            parseCompactParam(url.searchParams.get("compact")),
          ));
          return;
        }

        send(200, services.storage.listActivity({
          session_id: url.searchParams.get("session") ?? undefined,
          type: url.searchParams.get("type") ?? undefined,
          limit,
        }));
        return;
      }

      if (method === "GET" && path === "/stats") {
        send(200, services.storage.getStats());
        return;
      }

      if (method === "GET" && path === "/config") {
        const config = services.config.getEffective(url.searchParams.get("project_path") ?? undefined);
        send(200, {
          ...config,
          auth_token: "[redacted]",
        });
        return;
      }

      if (method === "PATCH" && path === "/config") {
        const body = await readBody<Partial<DaemonConfig>>();
        send(200, services.config.update(body));
        return;
      }

      if (method === "GET" && path === "/recent-work") {
        send(200, services.recentWork.list({
          includeActivityPreview: parseOptionalBooleanParam(url.searchParams.get("include_activity_preview")),
          previewLimit: parsePositiveInt(url.searchParams.get("activity_preview_limit")) ?? 3,
          compact: parseCompactParam(url.searchParams.get("compact")),
          previewTypes: parseCsvParam(url.searchParams.get("preview_types")) as never,
        }));
        return;
      }

      const recentWorkMatch = path.match(/^\/recent-work\/([^/]+)$/);
      if (method === "GET" && recentWorkMatch) {
        const detail = services.dashboard.getRecentWorkDetail(recentWorkMatch[1]);
        if (!detail) {
          sendNotFound();
          return;
        }
        send(200, detail);
        return;
      }

      const continueMatch = path.match(/^\/recent-work\/([^/]+)\/continue$/);
      if (method === "POST" && continueMatch) {
        const body = await readBody<{ instruction?: string }>();
        const task = services.recentWork.continueRecentWork(continueMatch[1], body.instruction);
        void services.scheduler.tick();
        send(201, task);
        return;
      }

      sendNotFound();
    } catch (error) {
      send(500, {
        error: error instanceof Error ? error.message : "Unknown server error",
      });
    }
  };

  const server = tls.enabled
    ? createHttpsListener({
        cert: readFileSync(tls.certPath!, "utf8"),
        key: readFileSync(tls.keyPath!, "utf8"),
      }, requestHandler)
    : createHttpListener(requestHandler);

  server.on("upgrade", (req, socket, head) => {
    handleWebSocketUpgrade(server, services, req, socket, head);
  });

  return server;
}

function handleWebSocketUpgrade(
  _server: HttpServer | HttpsServer,
  services: AppServices,
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
): void {
  if (!req.url || !req.method) {
    socket.destroy();
    return;
  }

  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method.toUpperCase();
  if (method !== "GET" || !isAuthorizedWebSocket(req, url, services.config.get().auth_token)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const accept = createWebSocketAccept(key);
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );

  let unsubscribe = () => {};
  let terminalSessionId: string | undefined;
  if (path === "/ws/events") {
    unsubscribe = services.liveEvents.subscribe((event) => {
      socket.write(encodeWebSocketTextFrame(JSON.stringify({ event: event.kind, data: event })));
    });
  } else {
    const eventsMatch = path.match(/^\/ws\/sessions\/([^/]+)\/events$/);
    const terminalMatch = path.match(/^\/ws\/sessions\/([^/]+)\/terminal$/);
    if (eventsMatch) {
      unsubscribe = services.liveEvents.subscribe((event) => {
        socket.write(encodeWebSocketTextFrame(JSON.stringify({ event: event.kind, data: event })));
      }, eventsMatch[1]);
    } else if (terminalMatch) {
      terminalSessionId = terminalMatch[1];
      const replayLimit = parsePositiveInt(url.searchParams.get("replay_limit")) ?? 200;
      for (const event of services.terminalStreams.list(terminalSessionId, replayLimit)) {
        socket.write(encodeWebSocketTextFrame(JSON.stringify({ event: "terminal", data: event })));
      }
      unsubscribe = services.terminalStreams.subscribe((event) => {
        socket.write(encodeWebSocketTextFrame(JSON.stringify({ event: "terminal", data: event })));
      }, terminalSessionId);
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  let buffered = head;
  const close = () => {
    unsubscribe();
    socket.destroy();
  };

  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const parsed = parseWebSocketFrames(buffered);
    buffered = parsed.remaining;
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) {
        close();
        return;
      }

      if (frame.opcode === 0x9) {
        socket.write(encodeWebSocketPongFrame(frame.payload));
        continue;
      }

      if (frame.opcode === 0x1 && terminalSessionId) {
        try {
          const message = parseTerminalControlMessage(frame.payload.toString("utf8"));
          if (message.type === "send_message") {
            services.sessions.sendMessage(terminalSessionId, message.message ?? "");
            socket.write(encodeWebSocketTextFrame(JSON.stringify({
              event: "control_ack",
              data: {
                type: "send_message",
              },
            })));
          } else if (message.type === "stdin") {
            services.sessions.writeInput(terminalSessionId, message.data ?? "");
            socket.write(encodeWebSocketTextFrame(JSON.stringify({
              event: "control_ack",
              data: {
                type: "stdin",
              },
            })));
          } else if (message.type === "resize") {
            services.sessions.resizeTerminal(terminalSessionId, message.cols ?? 0, message.rows ?? 0);
            socket.write(encodeWebSocketTextFrame(JSON.stringify({
              event: "control_ack",
              data: {
                type: "resize",
                cols: message.cols,
                rows: message.rows,
              },
            })));
          } else if (message.type === "stop") {
            services.sessions.stop(terminalSessionId);
            socket.write(encodeWebSocketTextFrame(JSON.stringify({
              event: "control_ack",
              data: {
                type: "stop",
              },
            })));
          }
        } catch (error) {
          socket.write(encodeWebSocketTextFrame(JSON.stringify({
            event: "control_error",
            data: {
              message: error instanceof Error ? error.message : "Unknown control error",
            },
          })));
        }
      }
    }
  });
  socket.on("close", unsubscribe);
  socket.on("error", unsubscribe);
}
