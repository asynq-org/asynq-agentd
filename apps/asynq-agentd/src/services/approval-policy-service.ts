import type { ActivityPayload, DaemonConfig, TaskRecord } from "../domain.ts";

export interface ApprovalDecision {
  action: string;
  context: string;
}

export class ApprovalPolicyService {
  shouldRequireApproval(
    payload: ActivityPayload,
    task: TaskRecord,
    config: DaemonConfig,
  ): ApprovalDecision | undefined {
    if (payload.type === "command_run" || payload.type === "command_intent") {
      const normalized = payload.cmd.trim().toLowerCase();
      if (this.matchesAny(normalized, config.approval.never_require)) {
        return undefined;
      }

      if (this.matchesAny(normalized, config.approval.always_require)) {
        return {
          action: `${payload.type === "command_intent" ? "Approve upcoming command" : "Approve command"}: ${payload.cmd}`,
          context: payload.type === "command_intent"
            ? `Task "${task.title}" is about to run a command matching approval policy: ${payload.cmd}`
            : `Task "${task.title}" triggered a command matching approval policy: ${payload.cmd}`,
        };
      }

      const sensitivePathDecision = this.requireApprovalForSensitiveWrite(payload, task);
      if (sensitivePathDecision) {
        return sensitivePathDecision;
      }
    }

    if (payload.type === "file_delete") {
      return {
        action: `Approve file deletion: ${payload.path}`,
        context: `Task "${task.title}" deleted ${payload.path}. Approval is required before the session continues.`,
      };
    }

    if (payload.type === "file_batch" || payload.type === "file_batch_intent") {
      const deleted = payload.files.filter((file) => file.action === "deleted");
      if (deleted.length > 0) {
        return {
          action: payload.type === "file_batch_intent"
            ? "Approve upcoming file batch affecting deletions"
            : "Approve file batch affecting deletions",
          context: payload.type === "file_batch_intent"
            ? `Task "${task.title}" is about to change multiple files including deletions: ${deleted.map((file) => file.path).join(", ")}`
            : `Task "${task.title}" changed multiple files including deletions: ${deleted.map((file) => file.path).join(", ")}`,
        };
      }
    }

    if (payload.type === "model_call" && payload.cost_usd >= config.approval.cost_threshold) {
      return {
        action: `Approve model spend: $${payload.cost_usd.toFixed(2)}`,
        context: `Task "${task.title}" exceeded the configured model cost threshold with ${payload.model} costing $${payload.cost_usd.toFixed(2)}.`,
      };
    }

    return undefined;
  }

  private matchesAny(value: string, patterns: string[]): boolean {
    return patterns.some((pattern) => value.includes(pattern.trim().toLowerCase()));
  }

  private requireApprovalForSensitiveWrite(
    payload: Extract<ActivityPayload, { type: "command_run" | "command_intent" }>,
    task: TaskRecord,
  ): ApprovalDecision | undefined {
    const command = payload.cmd.trim();
    const normalized = command.toLowerCase();
    if (!this.looksLikeWriteCommand(normalized)) {
      return undefined;
    }

    const sensitivePath = this.pickSensitivePath(normalized, task.project_path);
    if (!sensitivePath) {
      return undefined;
    }

    return {
      action: `${payload.type === "command_intent" ? "Approve upcoming protected write" : "Approve protected write"}: ${command}`,
      context: payload.type === "command_intent"
        ? `Task "${task.title}" is about to write to a protected path outside the project workspace: ${sensitivePath}`
        : `Task "${task.title}" wrote to a protected path outside the project workspace: ${sensitivePath}`,
    };
  }

  private looksLikeWriteCommand(command: string): boolean {
    return /\b(cp|mv|rm|mkdir|touch|install|tee|dd|ln|rsync)\b/.test(command)
      || /\b(cat|echo|printf)\b.*[>]{1,2}/.test(command);
  }

  private pickSensitivePath(command: string, projectPath: string): string | undefined {
    const home = (process.env.HOME ?? "").toLowerCase();
    const project = projectPath.trim().toLowerCase();
    const candidates = [
      "~/.asynq-agentd",
      `${home}/.asynq-agentd`,
      "~/.ssh",
      `${home}/.ssh`,
      "~/.gnupg",
      `${home}/.gnupg`,
      "~/.codex",
      `${home}/.codex`,
      "~/.claude",
      `${home}/.claude`,
    ].filter(Boolean);

    const matchedSensitive = candidates.find((candidate) => command.includes(candidate));
    if (matchedSensitive && !project.startsWith(matchedSensitive.replace(/^~\//, `${home}/`))) {
      return matchedSensitive;
    }

    return undefined;
  }
}
