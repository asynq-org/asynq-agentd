import { cwd } from "node:process";
import { resolveRuntimePaths, writeAuthFile } from "./config.ts";
import { AsynqAgentdStorage } from "./db/storage.ts";
import { TaskService } from "./services/task-service.ts";
import { SessionService } from "./services/session-service.ts";
import { ConfigService } from "./services/config-service.ts";
import { SchedulerService } from "./services/scheduler.ts";
import { ProjectConfigService } from "./services/project-config-service.ts";
import { RecentWorkService } from "./services/recent-work-service.ts";
import { MockAgentAdapter } from "./adapters/mock-adapter.ts";
import { CodexCliAdapter } from "./adapters/codex-adapter.ts";
import { ClaudeCliAdapter } from "./adapters/claude-adapter.ts";
import { EventStreamService } from "./services/event-stream-service.ts";
import { TerminalStreamService } from "./services/terminal-stream-service.ts";
import { DashboardService } from "./services/dashboard-service.ts";
import { createHttpServer } from "./http/server.ts";
import { RuntimeDiscoveryService } from "./services/runtime-discovery-service.ts";
import { SummaryService } from "./services/summary-service.ts";

const port = Number(process.env.PORT ?? 7433);
const host = process.env.HOST ?? "127.0.0.1";
const runtimePaths = resolveRuntimePaths(cwd());

const storage = new AsynqAgentdStorage(runtimePaths.dbPath);
const projectConfig = new ProjectConfigService();
const tasks = new TaskService(storage, projectConfig);
const liveEvents = new EventStreamService();
const terminalStreams = new TerminalStreamService(storage);
const sessions = new SessionService(storage, liveEvents);
const config = new ConfigService(storage, projectConfig);
const runtimes = new RuntimeDiscoveryService();
const summaries = new SummaryService({
  storage,
  events: liveEvents,
  runtimes,
  getConfig: () => config.get(),
});
const adapters = new Map([
  ["claude-code", new ClaudeCliAdapter()],
  ["codex", new CodexCliAdapter({
    codexHome: runtimePaths.codexPath,
  })],
  ["opencode", new MockAgentAdapter()],
  ["custom", new MockAgentAdapter()],
]);
const scheduler = new SchedulerService(storage, tasks, sessions, config, adapters, undefined, undefined, terminalStreams);
const recentWork = new RecentWorkService(storage, tasks, {
  claudePath: runtimePaths.claudePath,
  codexPath: runtimePaths.codexPath,
  events: liveEvents,
  onRecentWorkBatchUpdated: (records) => {
    summaries.prepareContinueCards(records);
  },
});
const dashboard = new DashboardService({
  storage,
  tasks,
  sessions,
  recentWork,
  summaries,
  runtimes,
});
const server = createHttpServer({
  storage,
  tasks,
  sessions,
  config,
  scheduler,
  recentWork,
  liveEvents,
  terminalStreams,
  dashboard,
});

server.on("error", (error) => {
  console.error(`asynq-agentd failed to listen on http://${host}:${port}`);
  console.error(error instanceof Error ? error.message : String(error));
  scheduler.stop();
  recentWork.stopWatching();
  storage.close();
  process.exit(1);
});

server.listen(port, host, () => {
  const activeConfig = config.get();
  writeAuthFile(runtimePaths, activeConfig);
  scheduler.start(500);
  recentWork.startWatching();
  console.log(`asynq-agentd listening on http://${host}:${port}`);
  console.log(`runtime db: ${runtimePaths.dbPath}`);
  console.log(`auth token path: ${runtimePaths.authPath}`);
});

process.on("SIGINT", () => {
  scheduler.stop();
  recentWork.stopWatching();
  server.close(() => {
    storage.close();
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  scheduler.stop();
  recentWork.stopWatching();
  server.close(() => {
    storage.close();
    process.exit(0);
  });
});
