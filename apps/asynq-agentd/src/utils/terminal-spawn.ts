import { existsSync } from "node:fs";

export interface TerminalSpawnPlan {
  command: string;
  args: string[];
  mode: "pipe" | "pty";
  transport: "direct" | "script";
}

export function createTerminalSpawnPlan(command: string, args: string[]): TerminalSpawnPlan {
  const preference = (process.env.ASYNQ_AGENTD_TERMINAL_MODE ?? "auto").toLowerCase();
  const scriptPath = "/usr/bin/script";
  const scriptAvailable = process.platform === "darwin" && existsSync(scriptPath);
  const parentHasTty = Boolean(process.stdin.isTTY);
  const canUsePty = scriptAvailable && parentHasTty && preference !== "pipe";

  if (canUsePty || (preference === "pty" && scriptAvailable && parentHasTty)) {
    if (scriptAvailable) {
      return {
        command: scriptPath,
        args: ["-q", "/dev/null", command, ...args],
        mode: "pty",
        transport: "script",
      };
    }
  }

  return {
    command,
    args,
    mode: "pipe",
    transport: "direct",
  };
}
