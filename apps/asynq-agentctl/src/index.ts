import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import QRCode from "qrcode";

const baseUrl = process.env.ASYNQ_AGENTD_URL ?? process.env.AGENTD_URL ?? "http://127.0.0.1:7433";
const publicUrl = process.env.ASYNQ_AGENTD_PUBLIC_URL ?? process.env.AGENTD_PUBLIC_URL ?? baseUrl;
const runtimeHome = process.env.ASYNQ_AGENTD_HOME ?? process.env.AGENTD_HOME;

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
  const claudePath = process.env.ASYNQ_AGENTD_CLAUDE_BIN
    ?? process.env.CLAUDE_BIN
    ?? findExecutable("claude", [resolve(process.env.HOME ?? "~", ".local/bin/claude")]);
  const codexPath = process.env.ASYNQ_AGENTD_CODEX_BIN
    ?? process.env.CODEX_BIN
    ?? findExecutable("codex");
  const opencodePath = process.env.ASYNQ_AGENTD_OPENCODE_BIN
    ?? process.env.OPENCODE_BIN
    ?? findExecutable("opencode", [resolve(process.env.HOME ?? "~", ".opencode/bin/opencode")]);

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
    const [stats, sessions, approvals] = await Promise.all([
      request("/stats"),
      request("/sessions"),
      request("/approvals?status=pending"),
    ]);

    const activeSessions = Array.isArray(sessions) ? sessions : [];
    const pendingApprovals = Array.isArray(approvals) ? approvals : [];

    print({
      endpoint: baseUrl,
      public_url: publicUrl,
      daemon: {
        reachable: true,
        auth_token_present: Boolean(resolveToken()),
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
      console.error("Commands: status, agents, sessions, dashboard, tasks, approvals, approve, reject, recent-work, continue, submit, activity, config, token, pairing");
      process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
