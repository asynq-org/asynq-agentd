import { accessSync, constants, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, watchFile, writeFileSync, unwatchFile } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, networkInterfaces, platform, tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
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
const speechModelDir = resolve(runtimeRoot, "models");
const defaultWhisperModel = "base";
const defaultWhisperModelPath = resolve(speechModelDir, `ggml-${defaultWhisperModel}.bin`);
const defaultWhisperModelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${defaultWhisperModel}.bin`;

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

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isLikelyIpv4(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value.trim());
}

function isValidIpv4(value: string): boolean {
  if (!isLikelyIpv4(value)) {
    return false;
  }

  return value.split(".").every((segment) => {
    const parsed = Number(segment);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255;
  });
}

function isPreferredFallbackIpv4(value: string): boolean {
  if (!isValidIpv4(value)) {
    return false;
  }

  const [a, b] = value.split(".").map((segment) => Number(segment));
  if (a === 10) {
    return true;
  }

  if (a === 192 && b === 168) {
    return true;
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }

  // Tailscale carrier-grade range.
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }

  return false;
}

function formatExecError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const maybe = error as {
    message?: string;
    stderr?: Buffer | string;
    stdout?: Buffer | string;
  };
  const stderr = typeof maybe.stderr === "string"
    ? maybe.stderr
    : maybe.stderr instanceof Buffer
      ? maybe.stderr.toString("utf8")
      : "";
  const stdout = typeof maybe.stdout === "string"
    ? maybe.stdout
    : maybe.stdout instanceof Buffer
      ? maybe.stdout.toString("utf8")
      : "";
  const detail = (stderr || stdout).trim();
  if (detail) {
    return detail.split("\n")[0] ?? detail;
  }

  return maybe.message ?? String(error);
}

function extractAllowedCertDomains(message: string): string[] {
  const match = message.match(/must be one of (\[[^\]]+\])/i);
  if (!match?.[1]) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function normalizeDnsName(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().replace(/\.$/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractSelfDnsName(statusJson: string): string | undefined {
  try {
    const parsed = JSON.parse(statusJson) as { Self?: { DNSName?: string } };
    return normalizeDnsName(parsed?.Self?.DNSName);
  } catch {
    return undefined;
  }
}

function updateEnvFileValue(key: string, value: string): string | undefined {
  const envPath = process.env.ASYNQ_AGENTD_ENV_FILE ?? resolve(runtimeRoot, "asynq-agentd.env");
  const nextLine = `${key}=${value}`;

  try {
    const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const lines = current
      .split("\n")
      .filter((line) => line.length > 0);
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) {
      lines[index] = nextLine;
    } else {
      lines.push(nextLine);
    }

    writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");
    return envPath;
  } catch {
    return undefined;
  }
}

function updatePublicUrlInEnv(nextPublicUrl: string): string | undefined {
  return updateEnvFileValue("ASYNQ_AGENTD_PUBLIC_URL", nextPublicUrl);
}

function firstIpv4FromText(value: string): string | undefined {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (isValidIpv4(line)) {
      return line;
    }
  }
  return undefined;
}

function resolveLocalFallbackIpv4(): string | undefined {
  const all = networkInterfaces();
  const candidates: string[] = [];
  for (const entries of Object.values(all)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      if (isPreferredFallbackIpv4(entry.address)) {
        candidates.push(entry.address);
      }
    }
  }

  return candidates[0];
}

function withHost(endpointRaw: string, host: string): string {
  const next = new URL(endpointRaw);
  next.hostname = host;
  return next.toString().replace(/\/$/, "");
}

function tryHttpIpFallback(args: string[], endpointRaw: string, tailscalePath?: string): { endpoint: string; notes: string[] } | null {
  if (args.includes("--no-ip-fallback")) {
    return null;
  }

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpointRaw);
  } catch {
    return null;
  }

  if (endpointUrl.protocol !== "http:") {
    return null;
  }

  const notes: string[] = [];
  const explicitIp = getFlag(args, "--ip-fallback");
  if (explicitIp) {
    if (isValidIpv4(explicitIp)) {
      return {
        endpoint: withHost(endpointRaw, explicitIp),
        notes: ["Using explicit IP fallback endpoint (--ip-fallback)."],
      };
    }
    notes.push(`Ignored invalid --ip-fallback value: ${explicitIp}.`);
  }

  if (tailscalePath) {
    try {
      const output = execFileSync(tailscalePath, ["ip", "-4"], { stdio: "pipe" }).toString("utf8");
      const tsIp = firstIpv4FromText(output);
      if (tsIp) {
        return {
          endpoint: withHost(endpointRaw, tsIp),
          notes: [...notes, `Using Tailscale IP fallback endpoint: ${tsIp}.`],
        };
      }
    } catch {
      // Ignore and continue to local-interface fallback.
    }
  }

  const localIp = resolveLocalFallbackIpv4();
  if (localIp) {
    return {
      endpoint: withHost(endpointRaw, localIp),
      notes: [...notes, `Using local IPv4 fallback endpoint: ${localIp}.`],
    };
  }

  if (notes.length > 0) {
    return { endpoint: endpointRaw, notes };
  }

  return null;
}

function isCertFresh(certPath: string, minSeconds = 24 * 60 * 60): boolean {
  const openssl = findExecutable("openssl");
  if (!openssl || !existsSync(certPath)) {
    return false;
  }

  try {
    execFileSync(openssl, ["x509", "-checkend", String(minSeconds), "-noout", "-in", certPath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shouldEnsureHttpsPairing(args: string[], endpoint: URL): boolean {
  if (args.includes("--no-ensure-https")) {
    return false;
  }

  if (args.includes("--ensure-https")) {
    return endpoint.protocol === "http:";
  }

  return endpoint.protocol === "http:" && endpoint.hostname.endsWith(".ts.net");
}

async function tryAutoHttpsPairing(args: string[], endpointRaw: string): Promise<{ endpoint: string; notes: string[] }> {
  const notes: string[] = [];
  let endpointUrl: URL;

  try {
    endpointUrl = new URL(endpointRaw);
  } catch {
    return { endpoint: endpointRaw, notes };
  }

  if (!shouldEnsureHttpsPairing(args, endpointUrl)) {
    return { endpoint: endpointRaw, notes };
  }

  const tailscale = findExecutable("tailscale");
  if (!tailscale) {
    notes.push("Auto HTTPS skipped: tailscale CLI not found on PATH.");
    const ipFallback = tryHttpIpFallback(args, endpointRaw);
    if (ipFallback) {
      return { endpoint: ipFallback.endpoint, notes: [...notes, ...ipFallback.notes] };
    }
    return { endpoint: endpointRaw, notes };
  }

  let tailscaleStatusJson: string;
  try {
    tailscaleStatusJson = execFileSync(tailscale, ["status", "--json"], { stdio: "pipe" }).toString("utf8");
  } catch (error) {
    notes.push(`Auto HTTPS skipped: tailscale status check failed (${formatExecError(error)}).`);
    const ipFallback = tryHttpIpFallback(args, endpointRaw, tailscale);
    if (ipFallback) {
      return { endpoint: ipFallback.endpoint, notes: [...notes, ...ipFallback.notes] };
    }
    return { endpoint: endpointRaw, notes };
  }

  const selfDnsName = extractSelfDnsName(tailscaleStatusJson);
  if (endpointUrl.hostname.endsWith(".ts.net") && selfDnsName && endpointUrl.hostname !== selfDnsName) {
    const nextFromStatus = new URL(endpointRaw);
    nextFromStatus.hostname = selfDnsName;
    endpointRaw = nextFromStatus.toString().replace(/\/$/, "");
    endpointUrl = new URL(endpointRaw);
    notes.push(`Pairing host updated to current Tailscale DNS name: ${selfDnsName}.`);
  }

  const certDir = getFlag(args, "--cert-dir") ?? resolve(runtimeRoot, "certs");
  let certDomain = endpointUrl.hostname;
  let certBase = sanitizeFilePart(certDomain);
  let certPath = getFlag(args, "--cert") ?? resolve(certDir, `${certBase}.crt`);
  let keyPath = getFlag(args, "--key") ?? resolve(certDir, `${certBase}.key`);

  try {
    mkdirSync(certDir, { recursive: true });
  } catch (error) {
    notes.push(`Auto HTTPS skipped: could not prepare cert directory (${error instanceof Error ? error.message : String(error)}).`);
    const ipFallback = tryHttpIpFallback(args, endpointRaw, tailscale);
    if (ipFallback) {
      return { endpoint: ipFallback.endpoint, notes: [...notes, ...ipFallback.notes] };
    }
    return { endpoint: endpointRaw, notes };
  }

  let certReady = isCertFresh(certPath);
  if (!certReady) {
    try {
      execFileSync(tailscale, ["cert", "--cert-file", certPath, "--key-file", keyPath, certDomain], { stdio: "pipe" });
      notes.push(`Generated/renewed TLS certificate for ${certDomain}.`);
    } catch (error) {
      const certError = formatExecError(error);
      const allowedDomains = extractAllowedCertDomains(certError);
      if (allowedDomains.length > 0) {
        certDomain = allowedDomains[0]!;
        certBase = sanitizeFilePart(certDomain);
        certPath = resolve(certDir, `${certBase}.crt`);
        keyPath = resolve(certDir, `${certBase}.key`);
        certReady = isCertFresh(certPath);
        notes.push(`Pairing host updated to allowed cert domain: ${certDomain}.`);
        if (!certReady) {
          try {
            execFileSync(tailscale, ["cert", "--cert-file", certPath, "--key-file", keyPath, certDomain], { stdio: "pipe" });
            notes.push(`Generated/renewed TLS certificate for ${certDomain}.`);
            certReady = true;
          } catch (retryError) {
            notes.push(`Auto HTTPS skipped: tailscale cert failed (${formatExecError(retryError)}).`);
            const ipFallback = tryHttpIpFallback(args, endpointRaw, tailscale);
            if (ipFallback) {
              return { endpoint: ipFallback.endpoint, notes: [...notes, ...ipFallback.notes] };
            }
            return { endpoint: endpointRaw, notes };
          }
        } else {
          notes.push(`Using existing TLS certificate for ${certDomain}.`);
        }
      } else {
        notes.push(`Auto HTTPS skipped: tailscale cert failed (${certError}).`);
        const ipFallback = tryHttpIpFallback(args, endpointRaw, tailscale);
        if (ipFallback) {
          return { endpoint: ipFallback.endpoint, notes: [...notes, ...ipFallback.notes] };
        }
        return { endpoint: endpointRaw, notes };
      }
    }
  } else {
    notes.push(`Using existing TLS certificate for ${certDomain}.`);
  }

  try {
    await request("/config", {
      method: "PATCH",
      body: JSON.stringify({
        tls: {
          enabled: true,
          cert_path: certPath,
          key_path: keyPath,
        },
      }),
    });
  } catch (error) {
    notes.push(`Auto HTTPS cert is ready, but enabling daemon TLS failed (${error instanceof Error ? error.message : String(error)}).`);
    const ipFallback = tryHttpIpFallback(args, endpointRaw, tailscale);
    if (ipFallback) {
      return { endpoint: ipFallback.endpoint, notes: [...notes, ...ipFallback.notes] };
    }
    return { endpoint: endpointRaw, notes };
  }

  if (tryRestartServiceSilently()) {
    notes.push("Daemon restart requested after TLS update.");
  } else {
    notes.push("TLS configured. Restart daemon to start serving HTTPS.");
  }

  const next = new URL(endpointRaw);
  next.hostname = certDomain;
  next.protocol = "https:";
  const nextEndpoint = next.toString().replace(/\/$/, "");
  const persistedEnvPath = updatePublicUrlInEnv(nextEndpoint);
  if (persistedEnvPath) {
    notes.push(`Persisted ASYNQ_AGENTD_PUBLIC_URL in ${persistedEnvPath}.`);
  } else {
    notes.push("Could not persist ASYNQ_AGENTD_PUBLIC_URL automatically.");
  }
  return { endpoint: nextEndpoint, notes };
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

  return false;
}

function shouldOpenQrInBrowser(args: string[], format: string): boolean {
  if (format === "json") {
    return false;
  }

  if (args.includes("--no-open-qr") || args.includes("--no-browser-qr")) {
    return false;
  }

  return args.includes("--open-qr") || args.includes("--browser-qr");
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openUrlInBrowser(target: string): void {
  switch (servicePlatform) {
    case "darwin":
      execFileSync("open", [target], { stdio: "ignore" });
      return;
    case "win32":
      execFileSync("cmd", ["/c", "start", "", target], { stdio: "ignore" });
      return;
    default:
      execFileSync("xdg-open", [target], { stdio: "ignore" });
  }
}

async function openPairingQrInBrowser(pairingWebUrl: string): Promise<void> {
  const qrSvg = await QRCode.toString(pairingWebUrl, {
    type: "svg",
    margin: 1,
    width: 520,
    color: {
      dark: "#111827",
      light: "#ffffff",
    },
  });
  const qrHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Asynq Buddy Pairing QR</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(1200px 700px at 20% -10%, #eef2ff 0%, #ffffff 55%);
        color: #0f172a;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .card {
        width: min(92vw, 760px);
        border-radius: 24px;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        box-shadow: 0 20px 45px rgba(15, 23, 42, 0.12);
        padding: 28px;
      }
      .eyebrow {
        letter-spacing: 0.08em;
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
        color: #475569;
      }
      h1 {
        margin: 8px 0 10px;
        font-size: clamp(1.5rem, 3vw, 2rem);
      }
      p {
        margin: 0 0 18px;
        color: #334155;
      }
      .qr {
        display: grid;
        place-items: center;
        margin: 14px 0 18px;
      }
      .qr svg {
        width: min(80vw, 520px);
        height: auto;
      }
      code {
        display: block;
        word-break: break-all;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 12px;
        color: #0f172a;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="eyebrow">Asynq Buddy Pairing</div>
      <h1>Scan this QR in the Buddy app</h1>
      <div class="qr">${qrSvg}</div>
      <code>${htmlEscape(pairingWebUrl)}</code>
    </main>
  </body>
</html>
`;
  const targetDir = mkdtempSync(resolve(tmpdir(), "asynq-agentctl-pairing-"));
  const htmlPath = resolve(targetDir, "pairing-qr.html");
  writeFileSync(htmlPath, qrHtml, "utf8");
  openUrlInBrowser(htmlPath);
}

async function printPairing(args: string[]): Promise<void> {
  const token = resolveToken();
  if (!token) {
    throw new Error("No auth token found. Start the daemon first so it can create auth.json.");
  }

  const requestedEndpoint = getFlag(args, "--public-url") ?? publicUrl;
  const { endpoint, notes } = await tryAutoHttpsPairing(args, requestedEndpoint);
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
  const openQrInBrowser = shouldOpenQrInBrowser(args, format)
    || (
      format !== "json"
      && !includeQr
      && !args.includes("--no-open-qr")
      && !args.includes("--no-browser-qr")
    );

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
  if (notes.length > 0) {
    for (const note of notes) {
      console.log(`Note: ${note}`);
    }
  }
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

  if (openQrInBrowser) {
    console.log("");
    try {
      await openPairingQrInBrowser(pairingWebUrl);
      console.log("Opened browser QR preview.");
    } catch {
      console.log("Could not open browser QR preview automatically.");
      console.log("Use the web fallback URL above, or rerun with --qr for terminal QR.");
    }
  } else {
    console.log("");
    console.log("Tip: use --open-qr for browser QR preview, or --qr for terminal QR.");
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

function tryRestartServiceSilently(): boolean {
  try {
    const kind = requireInstalledService();
    if (kind === "launchd") {
      const uid = typeof process.getuid === "function" ? String(process.getuid()) : undefined;
      if (!uid) {
        return false;
      }
      const domainTarget = `gui/${uid}/${launchdLabel}`;
      execFileSync("launchctl", ["kickstart", "-k", domainTarget], { stdio: "ignore" });
      return true;
    }

    execFileSync("systemctl", ["--user", "restart", systemdUnitName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, targetPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, buffer);
}

function resolveWhisperModelFromEnv(): string | undefined {
  return process.env.ASYNQ_AGENTD_WHISPER_MODEL;
}

function resolveSpeechStatus() {
  const whisperBin = findExecutable("whisper-cli", [
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
  ]);
  const ffmpegBin = findExecutable("ffmpeg", [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ]);
  const modelPath = resolveWhisperModelFromEnv() ?? (existsSync(defaultWhisperModelPath) ? defaultWhisperModelPath : undefined);

  return {
    whisper_cli: whisperBin ?? null,
    ffmpeg: ffmpegBin ?? null,
    model_path: modelPath ?? null,
    model_present: Boolean(modelPath && existsSync(modelPath)),
    env_file: process.env.ASYNQ_AGENTD_ENV_FILE ?? resolve(runtimeRoot, "asynq-agentd.env"),
  };
}

async function configureSpeech(args: string[]): Promise<void> {
  const action = args[0];
  if (!action || !["status", "setup"].includes(action)) {
    throw new Error("Usage: speech <status|setup> [--install-model] [--model <name>] [--model-url <url>] [--model-path <path>] [--force] [--restart]");
  }

  if (action === "status") {
    print(resolveSpeechStatus());
    return;
  }

  const installModel = args.includes("--install-model");
  const force = args.includes("--force");
  const restart = args.includes("--restart");
  const requestedModel = getFlag(args, "--model") ?? defaultWhisperModel;
  const modelUrl = getFlag(args, "--model-url") ?? `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${requestedModel}.bin`;
  const modelPath = resolve(getFlag(args, "--model-path") ?? resolve(speechModelDir, `ggml-${requestedModel}.bin`));
  const whisperBin = findExecutable("whisper-cli", [
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
  ]);
  const ffmpegBin = findExecutable("ffmpeg", [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ]);

  if (installModel && (!existsSync(modelPath) || force)) {
    mkdirSync(speechModelDir, { recursive: true });
    await downloadFile(modelUrl, modelPath);
  }

  if (!existsSync(modelPath)) {
    throw new Error(`Whisper model not found at ${modelPath}. Re-run with --install-model or pass --model-path.`);
  }

  const envFile = updateEnvFileValue("ASYNQ_AGENTD_WHISPER_MODEL", modelPath);
  if (ffmpegBin) {
    updateEnvFileValue("ASYNQ_AGENTD_FFMPEG_BIN", ffmpegBin);
  }
  if (whisperBin) {
    updateEnvFileValue("ASYNQ_AGENTD_WHISPER_BIN", whisperBin);
  }

  const restarted = restart ? tryRestartServiceSilently() : false;
  print({
    ok: true,
    env_file: envFile ?? null,
    whisper_cli: whisperBin ?? null,
    ffmpeg: ffmpegBin ?? null,
    model_path: modelPath,
    model_downloaded: installModel,
    restart_requested: restart,
    restarted,
    notes: [
      !whisperBin ? "whisper-cli not found on PATH; transcription will not work until it is installed." : undefined,
      !ffmpegBin ? "ffmpeg not found on PATH; non-WAV recordings will fail until it is installed." : undefined,
      restart && !restarted ? "Daemon restart was requested but no installed user service was found." : undefined,
    ].filter(Boolean),
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
    case "speech":
      await configureSpeech(args);
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
      console.error("Commands: status, agents, sessions, dashboard, tasks, approvals, approve, reject, recent-work, continue, submit, activity, config, token, pairing, debug, tls, speech, logs, start, stop, restart");
      process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
