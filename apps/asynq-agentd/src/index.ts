import { cwd } from "node:process";
import { resolveRuntimePaths, writeAuthFile } from "./config.ts";
import { existsSync } from "node:fs";
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
import { createDaemonServer } from "./http/server.ts";
import { RuntimeDiscoveryService } from "./services/runtime-discovery-service.ts";
import { SummaryService } from "./services/summary-service.ts";
import { initializeLogger } from "./logger.ts";
import { UpdateService } from "./services/update-service.ts";
import { ObservedResolutionService } from "./services/observed-resolution-service.ts";
import { CodexGuiBridgeService } from "./services/codex-gui-bridge-service.ts";

const port = Number(process.env.PORT ?? 7433);
const host = process.env.HOST ?? "127.0.0.1";
const runtimePaths = resolveRuntimePaths(cwd());
initializeLogger(runtimePaths.logPath);

const storage = new AsynqAgentdStorage(runtimePaths.dbPath);
const projectConfig = new ProjectConfigService();
const tasks = new TaskService(storage, projectConfig);
const liveEvents = new EventStreamService();
const terminalStreams = new TerminalStreamService(storage);
const sessions = new SessionService(storage, liveEvents);
const config = new ConfigService(storage, projectConfig);
const runtimes = new RuntimeDiscoveryService();
const discoveredRuntimes = new Map(runtimes.list().map((runtime) => [runtime.id, runtime]));
const summaries = new SummaryService({
  storage,
  events: liveEvents,
  runtimes,
  getConfig: () => config.get(),
});
const adapters = new Map([
  ["claude-code", new ClaudeCliAdapter({
    binPath: discoveredRuntimes.get("claude-code")?.path,
  })],
  ["codex", new CodexCliAdapter({
    binPath: discoveredRuntimes.get("codex")?.path,
    codexHome: runtimePaths.codexPath,
  })],
  ["opencode", new MockAgentAdapter()],
  ["custom", new MockAgentAdapter()],
]);
const codexAdapter = adapters.get("codex");
const claudeAdapter = adapters.get("claude-code");
const scheduler = new SchedulerService(storage, tasks, sessions, config, adapters, undefined, undefined, terminalStreams);
const recentWork = new RecentWorkService(storage, tasks, {
  claudePath: runtimePaths.claudePath,
  claudeDesktopPath: runtimePaths.claudeDesktopPath,
  codexPath: runtimePaths.codexPath,
  events: liveEvents,
  onRecentWorkBatchUpdated: (records) => {
    summaries.prepareContinueCards(records);
  },
});
const updates = new UpdateService();
const codexGuiBridge = new CodexGuiBridgeService();
const dashboard = new DashboardService({
  storage,
  tasks,
  sessions,
  recentWork,
  summaries,
  runtimes,
  updates,
  codexObservedBridgeAvailable: codexGuiBridge.isAvailable(),
  codexResumeContinuationAvailable: Boolean(codexAdapter?.appendToConversation),
  claudeResumeContinuationAvailable: Boolean(claudeAdapter?.appendToConversation),
});
const observedResolution = new ObservedResolutionService({
  dashboard,
  recentWork,
  scheduler,
  codexAdapter,
  claudeAdapter,
  codexBridge: codexGuiBridge,
});
const activeConfig = config.get();
const envTlsEnabled = process.env.ASYNQ_AGENTD_TLS_ENABLED === "1";
const tlsEnabled = activeConfig.tls.enabled || envTlsEnabled;
const tlsCertPath = process.env.ASYNQ_AGENTD_TLS_CERT ?? activeConfig.tls.cert_path ?? runtimePaths.tlsCertPath;
const tlsKeyPath = process.env.ASYNQ_AGENTD_TLS_KEY ?? activeConfig.tls.key_path ?? runtimePaths.tlsKeyPath;

if (tlsEnabled && (!existsSync(tlsCertPath) || !existsSync(tlsKeyPath))) {
  console.error("asynq-agentd TLS is enabled but the certificate or key file is missing.");
  console.error(`cert: ${tlsCertPath}`);
  console.error(`key: ${tlsKeyPath}`);
  process.exit(1);
}

const scheme = tlsEnabled ? "https" : "http";
const server = createDaemonServer({
  storage,
  tasks,
  sessions,
  config,
  scheduler,
  recentWork,
  liveEvents,
  terminalStreams,
  dashboard,
  updates,
  observedResolution,
}, {
  enabled: tlsEnabled,
  certPath: tlsCertPath,
  keyPath: tlsKeyPath,
});

server.on("error", (error) => {
  console.error(`asynq-agentd failed to listen on ${scheme}://${host}:${port}`);
  console.error(error instanceof Error ? error.message : String(error));
  scheduler.stop();
  recentWork.stopWatching();
  storage.close();
  process.exit(1);
});

server.listen(port, host, () => {
  writeAuthFile(runtimePaths, activeConfig);
  scheduler.start(500);
  updates.start();
  recentWork.startWatching();
  console.log(`asynq-agentd listening on ${scheme}://${host}:${port}`);
  console.log(`runtime db: ${runtimePaths.dbPath}`);
  console.log(`auth token path: ${runtimePaths.authPath}`);
  if (tlsEnabled) {
    console.log(`tls cert: ${tlsCertPath}`);
    console.log(`tls key: ${tlsKeyPath}`);
  }
});

process.on("SIGINT", () => {
  scheduler.stop();
  updates.stop();
  recentWork.stopWatching();
  server.close(() => {
    storage.close();
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  scheduler.stop();
  updates.stop();
  recentWork.stopWatching();
  server.close(() => {
    storage.close();
    process.exit(0);
  });
});
