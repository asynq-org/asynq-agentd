import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import type { RuntimeAdapterAvailability } from "../domain.ts";

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

export class RuntimeDiscoveryService {
  list(): RuntimeAdapterAvailability[] {
    const home = process.env.HOME ?? homedir();
    const claudePath = process.env.ASYNQ_AGENTD_CLAUDE_BIN
      ?? process.env.CLAUDE_BIN
      ?? findExecutable("claude", [
        resolve(home, ".local/bin/claude"),
      ]);
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
        path: claudePath,
        mode: "real",
      },
      {
        id: "codex",
        adapter: "codex-cli",
        available: Boolean(codexPath),
        path: codexPath,
        mode: "real",
      },
      {
        id: "opencode",
        adapter: "mock",
        available: Boolean(opencodePath),
        path: opencodePath,
        mode: opencodePath ? "binary-detected-but-daemon-mock" : "mock",
      },
      {
        id: "custom",
        adapter: "mock",
        available: true,
        mode: "mock",
      },
    ];
  }
}
