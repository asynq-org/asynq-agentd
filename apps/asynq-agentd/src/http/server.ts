import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
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
import { createWebSocketAccept, encodeWebSocketPongFrame, encodeWebSocketTextFrame, parseWebSocketFrames } from "../utils/websocket.ts";

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
}

interface TerminalControlMessage {
  type: "send_message" | "stdin" | "resize" | "stop";
  message?: string;
  data?: string;
  cols?: number;
  rows?: number;
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

export function createHttpServer(services: AppServices) {
  const server = createServer(async (req, res) => {
    if (!req.url || !req.method) {
      notFound(res);
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method.toUpperCase();

    try {
      if (!isPublicRoute(method, path) && !isAuthorized(req, services.config.get().auth_token)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      if (method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && path === "/") {
        sendJson(res, 200, {
          name: "asynq-agentd",
          status: "ok",
          version: "0.1.0-bootstrap",
        });
        return;
      }

      if (method === "GET" && path === "/sessions") {
        sendJson(res, 200, services.sessions.list());
        return;
      }

      if (method === "GET" && path === "/dashboard/overview") {
        sendJson(res, 200, services.dashboard.getOverview());
        return;
      }

      if (method === "GET" && path === "/dashboard/attention-required") {
        sendJson(res, 200, services.dashboard.getAttentionRequired());
        return;
      }

      if (method === "GET" && path === "/dashboard/continue-working") {
        sendJson(res, 200, services.dashboard.getContinueWorking());
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
          notFound(res);
          return;
        }
        sendJson(res, 200, detail);
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
        sendJson(res, 200, services.terminalStreams.list(
          sessionTerminalMatch[1],
          parsePositiveInt(url.searchParams.get("limit")) ?? 200,
        ));
        return;
      }

      const sessionMessageMatch = path.match(/^\/sessions\/([^/]+)\/message$/);
      if (method === "POST" && sessionMessageMatch) {
        const body = await readJson<{ message?: string }>(req);
        services.sessions.sendMessage(sessionMessageMatch[1], body.message ?? "");
        sendJson(res, 202, { ok: true });
        return;
      }

      if (method === "DELETE" && sessionMatch) {
        sendJson(res, 200, services.sessions.stop(sessionMatch[1]));
        return;
      }

      if (method === "GET" && path === "/tasks") {
        sendJson(res, 200, services.tasks.list());
        return;
      }

      if (method === "POST" && path === "/tasks") {
        const body = await readJson<CreateTaskInput>(req);
        const task = services.tasks.create(body);
        void services.scheduler.tick();
        sendJson(res, 201, task);
        return;
      }

      const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
      if (method === "PATCH" && taskMatch) {
        const body = await readJson<Record<string, unknown>>(req);
        const task = services.tasks.update(taskMatch[1], body);
        void services.scheduler.tick();
        sendJson(res, 200, task);
        return;
      }

      if (method === "DELETE" && taskMatch) {
        sendJson(res, 200, { deleted: services.tasks.delete(taskMatch[1]) });
        return;
      }

      if (method === "GET" && path === "/approvals") {
        const status = url.searchParams.get("status") ?? undefined;
        sendJson(res, 200, services.storage.listApprovals(status as never));
        return;
      }

      const approvalMatch = path.match(/^\/approvals\/([^/]+)$/);
      if (method === "POST" && approvalMatch) {
        const body = await readJson<{ decision: "approved" | "rejected"; note?: string }>(req);
        sendJson(res, 200, services.sessions.resolveApproval(approvalMatch[1], body.decision, body.note));
        return;
      }

      if (method === "GET" && path === "/activity") {
        const recentWorkId = url.searchParams.get("recent_work");
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
        if (recentWorkId) {
          sendJson(res, 200, services.recentWork.listImportedActivity(
            recentWorkId,
            limit,
            parseCompactParam(url.searchParams.get("compact")),
          ));
          return;
        }

        sendJson(res, 200, services.storage.listActivity({
          session_id: url.searchParams.get("session") ?? undefined,
          type: url.searchParams.get("type") ?? undefined,
          limit,
        }));
        return;
      }

      if (method === "GET" && path === "/stats") {
        sendJson(res, 200, services.storage.getStats());
        return;
      }

      if (method === "GET" && path === "/config") {
        const config = services.config.getEffective(url.searchParams.get("project_path") ?? undefined);
        sendJson(res, 200, {
          ...config,
          auth_token: "[redacted]",
        });
        return;
      }

      if (method === "PATCH" && path === "/config") {
        const body = await readJson<Partial<DaemonConfig>>(req);
        sendJson(res, 200, services.config.update(body));
        return;
      }

      if (method === "GET" && path === "/recent-work") {
        services.recentWork.scan();
        sendJson(res, 200, services.recentWork.list({
          includeActivityPreview: parseOptionalBooleanParam(url.searchParams.get("include_activity_preview")),
          previewLimit: parsePositiveInt(url.searchParams.get("activity_preview_limit")) ?? 3,
          compact: parseCompactParam(url.searchParams.get("compact")),
          previewTypes: parseCsvParam(url.searchParams.get("preview_types")) as never,
        }));
        return;
      }

      const continueMatch = path.match(/^\/recent-work\/([^/]+)\/continue$/);
      if (method === "POST" && continueMatch) {
        const body = await readJson<{ instruction?: string }>(req);
        const task = services.recentWork.continueRecentWork(continueMatch[1], body.instruction);
        void services.scheduler.tick();
        sendJson(res, 201, task);
        return;
      }

      notFound(res);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "Unknown server error",
      });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    handleWebSocketUpgrade(server, services, req, socket, head);
  });

  return server;
}

function handleWebSocketUpgrade(
  _server: Server,
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
  if (method !== "GET" || !isAuthorized(req, services.config.get().auth_token)) {
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
