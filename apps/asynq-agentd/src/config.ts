import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { DaemonConfig } from "./domain.ts";

export interface RuntimePaths {
  root: string;
  dbPath: string;
  authPath: string;
  logPath: string;
  claudePath: string;
  codexPath: string;
}

export function resolveRuntimePaths(cwd: string): RuntimePaths {
  const homeOverride = process.env.ASYNQ_AGENTD_HOME ?? process.env.AGENTD_HOME;
  const root = homeOverride ? resolve(homeOverride) : resolve(cwd, ".asynq-agentd");
  mkdirSync(root, { recursive: true });

  return {
    root,
    dbPath: resolve(root, "asynq-agentd.sqlite"),
    authPath: resolve(root, "auth.json"),
    logPath: resolve(root, "asynq-agentd.log"),
    claudePath: process.env.CLAUDE_HOME ? resolve(process.env.CLAUDE_HOME) : resolve(process.env.HOME ?? "~", ".claude"),
    codexPath: process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : resolve(process.env.HOME ?? "~", ".codex"),
  };
}

export function createDefaultConfig(): DaemonConfig {
  return {
    auth_token: createHash("sha256").update(randomBytes(32)).digest("hex"),
    max_parallel_sessions: 3,
    approval: {
      always_require: ["git push", "rm -rf", "deploy"],
      never_require: ["npm test", "npm run lint", "git add", "git commit"],
      cost_threshold: 1,
      timeout_minutes: 60,
    },
    model_routing: {
      default: "claude-sonnet",
      fallback: "claude-sonnet",
    },
    summaries: {
      enabled: true,
      provider: "auto",
      max_input_chars: 6000,
      debug: false,
    },
  };
}

export function writeAuthFile(paths: RuntimePaths, config: DaemonConfig): void {
  writeFileSync(paths.authPath, `${JSON.stringify({ token: config.auth_token }, null, 2)}\n`, "utf8");
}
