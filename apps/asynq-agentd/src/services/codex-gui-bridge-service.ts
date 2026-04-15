import { spawn } from "node:child_process";
import type { ObservedApprovalBridge } from "./observed-resolution-service.ts";

type BridgeDecision = "approved" | "rejected";

export class CodexGuiBridgeService implements ObservedApprovalBridge {
  private readonly enabled: boolean;
  private readonly timeoutMs: number;

  constructor(input: {
    enabled?: boolean;
    timeoutMs?: number;
  } = {}) {
    this.enabled = input.enabled ?? process.env.ASYNQ_AGENTD_CODEX_GUI_BRIDGE === "1";
    this.timeoutMs = Math.max(500, input.timeoutMs ?? 5000);
  }

  isAvailable(): boolean {
    return this.enabled && process.platform === "darwin";
  }

  async resolve(input: Parameters<ObservedApprovalBridge["resolve"]>[0]): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error("codex_gui_bridge_unavailable");
    }

    const command = normalizeNeedle(this.extractCommand(input.approval?.action) ?? this.extractCommand(input.approval?.context));
    const context = normalizeNeedle(input.approval?.context);
    const script = buildAppleScript({
      decision: input.decision,
      commandNeedle: command,
      contextNeedle: context,
    });

    const result = await runOsascript(script, this.timeoutMs);
    if (!result.ok) {
      throw new Error(result.message);
    }
  }

  private extractCommand(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    const fromLabel = value.match(/(?:Approve command|Pending command|Command):\s*(.+)$/i)?.[1]?.trim();
    if (fromLabel) {
      return fromLabel;
    }

    return undefined;
  }
}

function buildAppleScript(input: {
  decision: BridgeDecision;
  commandNeedle?: string;
  contextNeedle?: string;
}): string {
  const buttonWords = input.decision === "approved"
    ? ["approve", "allow", "run", "continue", "yes", "schválit", "povolit", "spustit", "pokračovat", "ano"]
    : ["reject", "deny", "cancel", "stop", "no", "zamítnout", "odmítnout", "zrušit", "ne"];

  return `
set decisionButtonWords to ${toAppleScriptList(buttonWords)}
set commandNeedle to ${toAppleScriptString(input.commandNeedle ?? "")}
set contextNeedle to ${toAppleScriptString(input.contextNeedle ?? "")}
set hasNeedle to commandNeedle is not "" or contextNeedle is not ""

on lowerText(valueText)
  return do shell script "/bin/echo " & quoted form of valueText & " | /usr/bin/tr '[:upper:]' '[:lower:]'"
end lowerText

on containsNeedle(haystackText, needleText)
  if needleText is "" then return false
  return (my lowerText(haystackText)) contains (my lowerText(needleText))
end containsNeedle

on textForElement(theElement, depth)
  if depth > 5 then return ""
  set parts to ""
  try
    set parts to parts & " " & (name of theElement as text)
  end try
  try
    set parts to parts & " " & (description of theElement as text)
  end try
  try
    set parts to parts & " " & (value of theElement as text)
  end try
  try
    repeat with childElement in UI elements of theElement
      set parts to parts & " " & my textForElement(childElement, depth + 1)
    end repeat
  end try
  return parts
end textForElement

on buttonMatches(theElement)
  try
    if role of theElement is not "AXButton" then return false
  on error
    return false
  end try

  set labelText to ""
  try
    set labelText to name of theElement as text
  end try
  try
    set labelText to labelText & " " & (description of theElement as text)
  end try
  set normalizedLabel to my lowerText(labelText)
  repeat with wordText in decisionButtonWords
    if normalizedLabel contains (wordText as text) then return true
  end repeat
  return false
end buttonMatches

on clickMatchingButton(theElement, depth)
  if depth > 7 then return false
  if my buttonMatches(theElement) then
    click theElement
    return true
  end if

  try
    repeat with childElement in UI elements of theElement
      if my clickMatchingButton(childElement, depth + 1) then return true
    end repeat
  end try
  return false
end clickMatchingButton

tell application "Codex" to activate
delay 0.25

tell application "System Events"
  tell process "Codex"
    set frontmost to true
    repeat with candidateWindow in windows
      set windowText to my textForElement(candidateWindow, 0)
      if (not hasNeedle) or (my containsNeedle(windowText, commandNeedle)) or (my containsNeedle(windowText, contextNeedle)) then
        if my clickMatchingButton(candidateWindow, 0) then
          return "OK"
        end if
      end if
    end repeat
  end tell
end tell

error "codex_gui_bridge_button_not_found"
`;
}

function normalizeNeedle(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length > 220 ? normalized.slice(0, 220) : normalized;
}

function toAppleScriptString(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return `"${normalized.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function toAppleScriptList(values: string[]): string {
  return `{${values.map(toAppleScriptString).join(", ")}}`;
}

async function runOsascript(script: string, timeoutMs: number): Promise<{ ok: boolean; message: string }> {
  return await new Promise((resolve) => {
    const child = spawn("osascript", [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, message: "codex_gui_bridge_timeout" });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, message: error.message });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0 && stdout.trim() === "OK") {
        resolve({ ok: true, message: "ok" });
        return;
      }

      const message = stderr.trim() || stdout.trim() || `osascript_exited_${code ?? "unknown"}`;
      resolve({ ok: false, message });
    });

    child.stdin.end(script);
  });
}
