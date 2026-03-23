import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const defaultMaxBytes = Number(process.env.ASYNQ_AGENTD_LOG_MAX_BYTES ?? 1024 * 1024 * 5);
const defaultMaxFiles = Number(process.env.ASYNQ_AGENTD_LOG_MAX_FILES ?? 5);

function rotateLogFile(path: string, maxFiles: number): void {
  const oldest = `${path}.${maxFiles}`;
  if (existsSync(oldest)) {
    unlinkSync(oldest);
  }

  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    const target = `${path}.${index + 1}`;
    if (existsSync(source)) {
      renameSync(source, target);
    }
  }

  if (existsSync(path)) {
    renameSync(path, `${path}.1`);
  }
}

function safeSerialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function initializeLogger(path: string, options?: { maxBytes?: number; maxFiles?: number }): void {
  const maxBytes = options?.maxBytes ?? defaultMaxBytes;
  const maxFiles = options?.maxFiles ?? defaultMaxFiles;

  const writeLine = (level: "INFO" | "ERROR" | "WARN", parts: unknown[]) => {
    try {
      const currentSize = existsSync(path) ? statSync(path).size : 0;
      if (currentSize >= maxBytes) {
        rotateLogFile(path, maxFiles);
      }

      const line = [
        `[${new Date().toISOString()}]`,
        level,
        ...parts.map((part) => safeSerialize(part)),
      ].join(" ");
      appendFileSync(path, `${line}\n`, "utf8");
    } catch {
      // Never let logging crash the daemon.
    }
  };

  if (!existsSync(path)) {
    writeFileSync(path, "", "utf8");
  }

  const originalConsoleLog = console.log.bind(console);
  const originalConsoleError = console.error.bind(console);
  const originalConsoleWarn = console.warn.bind(console);

  console.log = (...parts: unknown[]) => {
    writeLine("INFO", parts);
    originalConsoleLog(...parts);
  };

  console.error = (...parts: unknown[]) => {
    writeLine("ERROR", parts);
    originalConsoleError(...parts);
  };

  console.warn = (...parts: unknown[]) => {
    writeLine("WARN", parts);
    originalConsoleWarn(...parts);
  };

  process.on("uncaughtException", (error) => {
    writeLine("ERROR", ["uncaughtException", error]);
  });

  process.on("unhandledRejection", (reason) => {
    writeLine("ERROR", ["unhandledRejection", reason]);
  });
}

export function readLogTail(path: string, lines = 100): string {
  if (!existsSync(path)) {
    return "";
  }

  const content = readFileSync(path, "utf8");
  const selected = content.trimEnd().split("\n").slice(-Math.max(1, lines));
  return selected.join("\n");
}
