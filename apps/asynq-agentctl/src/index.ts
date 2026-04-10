import { accessSync, constants, createReadStream, existsSync, readFileSync, statSync, watchFile, unwatchFile } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { delimiter, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import QRCode from "qrcode";

const baseUrl = process.env.ASYNQ_AGENTD_URL ?? process.env.AGENTD_URL ?? "http://127.0.0.1:7433";
const publicUrl = process.env.ASYNQ_AGENTD_PUBLIC_URL ?? process.env.AGENTD_PUBLIC_URL ?? baseUrl;
const runtimeHome = process.env.ASYNQ_AGENTD_HOME ?? process.env.AGENTD_HOME;
const servicePlatform = platform();
const launchdLabel = "org.asynq.asynq-agentd";
const launchdPlistPath = resolve(homedir(), "Library/LaunchAgents", `${launchdLabel}.plist`);
const systemdUnitName = "asynq-agentd.service";
const systemdUnitPath = resolve(homedir(), ".config/systemd/user", systemdUnitName);
const runtimeRoot = runtimeHome ? resolve(runtimeHome) : resolve(process.cwd(), ".asynq-agentd");
const combinedLogPath = resolve(runtimeRoot, "asynq-agentd.log");
const stdoutLogPath = resolve(runtimeRoot, "asynq-agentd.stdout.log");
const stderrLogPath = resolve(runtimeRoot, "asynq-agentd.stderr.log");

function resolveToken(): string | undefined {
  if (process.env.ASYNQ_AGENTD_TOKEN) {
    return process.env.ASYNQ_AGENTD_TOKEN;
  }

  if (process.env.AGENTD_TOKEN) {
    return process.env.AGENTD_TOKEN;
  }

  try {
    const authPath = runtimeHome
      ? resolve(runtimeHome, "auth.json")
      : resolve(process.cwd(), ".asynq-agentd", "auth.json");
    const payload = JSON.parse(readFileSync(authPath, "utf8")) as { token?: string };
    return payload.token;
  } catch {
    return undefined;
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printText(value: string): void {
  process.stdout.write(`${value}\n`);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(name: string, extraCandidates: string[] = []): string | undefined {
  const candidates = [
    ...extraCandidates,
    ...String(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => resolve(entry, name)),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && canExecute(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function inspectAgents() {
  const home = process.env.HOME ?? homedir();
  const claudePath = process.env.ASYNQ_AGENTD_CLAUDE_BIN
    ?? process.env.CLAUDE_BIN
    ?? findExecutable("claude", [resolve(home, ".local/bin/claude")]);
  const codexPath = process.env.ASYNQ_AGENTD_CODEX_BIN
    ?? process.env.CODEX_BIN
    ?? findExecutable("codex", [
      "/Applications/Codex.app/Contents/Resources/codex",
      resolve(home, ".local/bin/codex"),
    ]);
  const opencodePath = process.env.ASYNQ_AGENTD_OPENCODE_BIN
    ?? process.env.OPENCODE_BIN
    ?? findExecutable("opencode", [resolve(home, ".opencode/bin/opencode")]);

  return [
    {
      id: "claude-code",
      adapter: "claude-cli",
      available: Boolean(claudePath),
      path: claudePath ?? null,
      mode: "real",
    },
    {
      id: "codex",
      adapter: "codex-cli",
      available: Boolean(codexPath),
      path: codexPath ?? null,
      mode: "real",
    },
    {
      id: "opencode",
      adapter: "mock",
      available: Boolean(opencodePath),
      path: opencodePath ?? null,
      mode: opencodePath ? "binary-detected-but-daemon-mock" : "mock",
    },
    {
      id: "custom",
      adapter: "mock",
      available: true,
      path: null,
      mode: "mock",
    },
  ];
}

function shouldPrintQr(args: string[], format: string): boolean {
  if (format === "json") {
    return false;
  }

  if (args.includes("--no-qr")) {
    return false;
  }

  if (args.includes("--qr")) {
    return true;
  }

  return Boolean(process.stdout.isTTY);
}

async function printPairing(args: string[]): Promise<void> {
  const token = resolveToken();
  if (!token) {
    throw new Error("No auth token found. Start the daemon first so it can create auth.json.");
  }

  const endpoint = getFlag(args, "--public-url") ?? publicUrl;
  const label = getFlag(args, "--label") ?? "Asynq Buddy";
  const payload = {
    endpoint,
    token,
    label,
    issued_at: new Date().toISOString(),
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const pairingUri = `asynqbuddy://pair?data=${encoded}`;
  const pairingWebUrl = `https://buddy.asynq.org/pair?data=${encoded}`;
  const format = getFlag(args, "--format") ?? "text";
  const includeQr = shouldPrintQr(args, format);

  if (format === "json") {
    print({
      endpoint,
      token,
      label,
      pairing_uri: pairingUri,
      pairing_web_url: pairingWebUrl,
    });
    return;
  }

  console.log(`Label: ${label}`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Pairing URI: ${pairingUri}`);
  console.log(`Web fallback: ${pairingWebUrl}`);

  if (includeQr) {
    const qr = await QRCode.toString(pairingWebUrl, {
      type: "terminal",
      small: true,
    });
    console.log("");
    process.stdout.write(qr);
  }
}

async function printStatus(): Promise<void> {
  try {
    const [stats, sessions, approvals, overview] = await Promise.all([
      request("/stats"),
      request("/sessions"),
      request("/approvals?status=pending"),
      request("/dashboard/overview").catch(() => undefined),
    ]);

    const activeSessions = Array.isArray(sessions) ? sessions : [];
    const pendingApprovals = Array.isArray(approvals) ? approvals : [];
    const daemonVersion = typeof overview?.daemon?.version === "string" ? overview.daemon.version : undefined;

    print({
      endpoint: baseUrl,
      public_url: publicUrl,
      daemon: {
        reachable: true,
        auth_token_present: Boolean(resolveToken()),
        version: daemonVersion ?? null,
      },
      agents: inspectAgents(),
      stats,
      sessions: activeSessions,
      approvals_pending: pendingApprovals.length,
      message: activeSessions.length > 0
        ? `Daemon is running with ${activeSessions.length} session${activeSessions.length === 1 ? "" : "s"}.`
        : "Daemon is reachable and there are no active sessions yet.",
    });
  } catch (error) {
    print({
      endpoint: baseUrl,
      public_url: publicUrl,
      daemon: {
        reachable: false,
        auth_token_present: Boolean(resolveToken()),
        version: null,
      },
      agents: inspectAgents(),
      message: "Daemon is not reachable yet. Start asynq-agentd or check HOST/PORT and auth token settings.",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function printDashboard(): Promise<void> {
  const overview = await request("/dashboard/overview");
  print(overview);
}

async function toggleDebug(args: string[]): Promise<void> {
  const action = args[0];
  if (!action || !["on", "off", "status"].includes(action)) {
    throw new Error("Usage: debug <on|off|status>");
  }

  if (action === "status") {
    const config = await request("/config");
    print({
      summaries_debug: Boolean(config?.summaries?.debug),
    });
    return;
  }

  const enabled = action === "on";
  const updated = await request("/config", {
    method: "PATCH",
    body: JSON.stringify({
      summaries: {
        debug: enabled,
      },
    }),
  });

  print({
    ok: true,
    summaries_debug: Boolean(updated?.summaries?.debug),
  });
}

async function configureTls(args: string[]): Promise<void> {
  const action = args[0];
  if (!action || !["status", "enable", "disable"].includes(action)) {
    throw new Error("Usage: tls <status|enable|disable> [--cert <path>] [--key <path>]");
  }

  if (action === "status") {
    const config = await request("/config");
    print({
      endpoint: baseUrl,
      public_url: publicUrl,
      tls: {
        enabled: Boolean(config?.tls?.enabled),
        cert_path: config?.tls?.cert_path ?? null,
        key_path: config?.tls?.key_path ?? null,
      },
    });
    return;
  }

  if (action === "disable") {
    const updated = await request("/config", {
      method: "PATCH",
      body: JSON.stringify({
        tls: {
          enabled: false,
        },
      }),
    });

    print({
      ok: true,
      tls: updated?.tls ?? { enabled: false },
      restart_required: true,
    });
    return;
  }

  const certPath = getFlag(args, "--cert");
  const keyPath = getFlag(args, "--key");
  if (!certPath || !keyPath) {
    throw new Error("Usage: tls enable --cert <path> --key <path>");
  }

  const updated = await request("/config", {
    method: "PATCH",
    body: JSON.stringify({
      tls: {
        enabled: true,
        cert_path: certPath,
        key_path: keyPath,
      },
    }),
  });

  print({
    ok: true,
    tls: updated?.tls,
    restart_required: true,
  });
}

async function printApprovals(args: string[]): Promise<void> {
  const status = getFlag(args, "--status") ?? "pending";
  print(await request(`/approvals?status=${encodeURIComponent(status)}`));
}

async function resolveApproval(args: string[], decision: "approved" | "rejected"): Promise<void> {
  const id = args[0];
  if (!id) {
    throw new Error(`Usage: ${decision === "approved" ? "approve" : "reject"} <approval_id> [--note <text>]`);
  }

  print(await request(`/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({
      decision,
      note: getFlag(args, "--note"),
    }),
  }));
}

async function printRecentWork(args: string[]): Promise<void> {
  const includePreview = args.includes("--preview");
  const limit = getFlag(args, "--preview-limit");
  const previewTypes = getFlag(args, "--preview-types");
  const compact = !args.includes("--raw-preview");
  const params = new URLSearchParams();

  if (includePreview) {
    params.set("include_activity_preview", "true");
    if (limit) {
      params.set("activity_preview_limit", limit);
    }
    if (previewTypes) {
      params.set("preview_types", previewTypes);
    }
    if (!compact) {
      params.set("compact", "false");
    }
  }

  const query = params.toString();
  print(await request(`/recent-work${query ? `?${query}` : ""}`));
}

async function continueRecentWork(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    throw new Error("Usage: continue <recent_work_id> [--instruction <text>]");
  }

  print(await request(`/recent-work/${encodeURIComponent(id)}/continue`, {
    method: "POST",
    body: JSON.stringify({
      instruction: getFlag(args, "--instruction"),
    }),
  }));
}

function printToken(args: string[]): void {
  const token = resolveToken();
  if (!token) {
    throw new Error("No auth token found. Start the daemon first so it can create auth.json.");
  }

  if (args.includes("--shell")) {
    printText(`export ASYNQ_AGENTD_TOKEN=${token}`);
    return;
  }

  if (args.includes("--json")) {
    print({ token });
    return;
  }

  printText(token);
}

function getFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function resolveLogPath(args: string[]): string {
  if (args.includes("--stdout")) {
    return stdoutLogPath;
  }

  if (args.includes("--stderr")) {
    return stderrLogPath;
  }

  return combinedLogPath;
}

function resolveExistingLogPath(args: string[]): string {
  const preferred = resolveLogPath(args);
  if (existsSync(preferred)) {
    return preferred;
  }

  if (!args.includes("--stdout") && !args.includes("--stderr")) {
    if (existsSync(stdoutLogPath)) {
      return stdoutLogPath;
    }

    if (existsSync(stderrLogPath)) {
      return stderrLogPath;
    }
  }

  return preferred;
}

async function printLogs(args: string[]): Promise<void> {
  const logPath = resolveExistingLogPath(args);
  const lineCount = Number(getFlag(args, "--lines") ?? "100");
  if (!existsSync(logPath)) {
    throw new Error(`No log file found yet at ${logPath}`);
  }

  const content = readFileSync(logPath, "utf8");
  const lines = content.trimEnd().split("\n");
  const tail = lines.slice(-Math.max(1, lineCount)).join("\n");
  if (tail) {
    printText(tail);
  }

  if (!args.includes("--follow")) {
    return;
  }

  let offset = statSync(logPath).size;
  const onChange = (current: { size: number }, previous: { size: number }) => {
    if (current.size < previous.size) {
      offset = 0;
    }

    if (current.size <= offset) {
      return;
    }

    const stream = createReadStream(logPath, {
      encoding: "utf8",
      start: offset,
      end: current.size - 1,
    });

    stream.on("data", (chunk) => {
      output.write(chunk);
    });

    stream.on("end", () => {
      offset = current.size;
    });
  };

  watchFile(logPath, { interval: 500 }, onChange);
  await new Promise<void>((resolvePromise) => {
    const stop = () => {
      unwatchFile(logPath, onChange);
      input.off("data", stop);
      resolvePromise();
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    input.resume();
    input.on("data", stop);
  });
}

function requireInstalledService(): "launchd" | "systemd" {
  if (servicePlatform === "darwin" && existsSync(launchdPlistPath)) {
    return "launchd";
  }

  if (servicePlatform === "linux" && existsSync(systemdUnitPath)) {
    return "systemd";
  }

  throw new Error(
    servicePlatform === "darwin"
      ? `No installed launchd service found. Install asynq-agentd with service mode 'user' or restart it manually. Expected ${launchdPlistPath}`
      : servicePlatform === "linux"
        ? `No installed systemd user service found. Install asynq-agentd with service mode 'user' or restart it manually. Expected ${systemdUnitPath}`
        : "Service lifecycle commands are not supported on this platform yet. Start asynq-agentd manually.",
  );
}

function runServiceLifecycle(action: "start" | "stop" | "restart"): void {
  const kind = requireInstalledService();

  if (kind === "launchd") {
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : undefined;
    if (!uid) {
      throw new Error("Could not resolve the current macOS user id for launchctl.");
    }

    const domainTarget = `gui/${uid}/${launchdLabel}`;
    if (action === "start") {
      execFileSync("launchctl", ["load", launchdPlistPath], { stdio: "ignore" });
      print({
        ok: true,
        service: "launchd",
        action,
        label: launchdLabel,
      });
      return;
    }

    if (action === "stop") {
      execFileSync("launchctl", ["unload", launchdPlistPath], { stdio: "ignore" });
      print({
        ok: true,
        service: "launchd",
        action,
        label: launchdLabel,
      });
      return;
    }

    execFileSync("launchctl", ["kickstart", "-k", domainTarget], { stdio: "ignore" });
    print({
      ok: true,
      service: "launchd",
      action,
      label: launchdLabel,
    });
    return;
  }

  execFileSync("systemctl", ["--user", action, systemdUnitName], { stdio: "ignore" });
  print({
    ok: true,
    service: "systemd",
    action,
    unit: systemdUnitName,
  });
}

async function request(path: string, init?: RequestInit) {
  const token = resolveToken();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with status ${response.status}`);
  }

  return body;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "status":
      await printStatus();
      return;
    case "sessions":
      print(await request("/sessions"));
      return;
    case "tasks":
      print(await request("/tasks"));
      return;
    case "agents":
      print({
        endpoint: baseUrl,
        agents: inspectAgents(),
      });
      return;
    case "dashboard":
      await printDashboard();
      return;
    case "debug":
      await toggleDebug(args);
      return;
    case "tls":
      await configureTls(args);
      return;
    case "logs":
      await printLogs(args);
      return;
    case "approvals":
      await printApprovals(args);
      return;
    case "approve":
      await resolveApproval(args, "approved");
      return;
    case "reject":
      await resolveApproval(args, "rejected");
      return;
    case "recent-work":
      await printRecentWork(args);
      return;
    case "continue":
      await continueRecentWork(args);
      return;
    case "activity":
      print(await request(`/activity${args[0] ? `?session=${encodeURIComponent(args[0])}` : ""}`));
      return;
    case "config":
      print(await request("/config"));
      return;
    case "token":
      printToken(args);
      return;
    case "pairing":
      await printPairing(args);
      return;
    case "start":
      runServiceLifecycle("start");
      return;
    case "stop":
      runServiceLifecycle("stop");
      return;
    case "restart":
      runServiceLifecycle("restart");
      return;
    case "submit": {
      const title = args[0];
      if (!title) {
        throw new Error("Usage: submit <title> --project <path> [--description <text>] [--agent <type>] [--priority <priority>] [--schedule <cron>] [--approval-required]");
      }

      const project = getFlag(args, "--project");
      if (!project) {
        throw new Error("Missing required --project flag");
      }

      const body = {
        title,
        description: getFlag(args, "--description") ?? title,
        project_path: project,
        agent_type: getFlag(args, "--agent") ?? "custom",
        priority: getFlag(args, "--priority") ?? "normal",
        model_preference: getFlag(args, "--model"),
        schedule: getFlag(args, "--schedule"),
        approval_required: args.includes("--approval-required"),
      };

      print(await request("/tasks", {
        method: "POST",
        body: JSON.stringify(body),
      }));
      return;
    }
    default:
      console.error("Commands: status, agents, sessions, dashboard, tasks, approvals, approve, reject, recent-work, continue, submit, activity, config, token, pairing, debug, tls, logs, start, stop, restart");
      process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
