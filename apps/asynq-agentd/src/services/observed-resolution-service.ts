import { setTimeout as delay } from "node:timers/promises";
import type { AgentAdapter } from "../adapters/agent-adapter.ts";
import type { AgentType, RecentWorkRecord, TaskRecord } from "../domain.ts";
import type { DashboardService } from "./dashboard-service.ts";
import type { RecentWorkService } from "./recent-work-service.ts";
import type { SchedulerService } from "./scheduler.ts";

export type ObservedResolutionStrategy = "auto" | "in_place" | "managed_handoff";

type ObservedApprovalDetail = {
  approval_id: string;
  recent_work_id?: string;
  action?: string;
  context?: string;
  agent_type?: AgentType;
  project_path?: string;
};

export type ResolveObservedApprovalInput = {
  approvalId: string;
  decision: "approved" | "rejected";
  note?: string;
  resolutionStrategy: ObservedResolutionStrategy;
  requireVerification: boolean;
};

type ResolutionPayload = {
  method: "in_place" | "managed_handoff" | "none";
  status: "verified" | "queued" | "failed";
  fallback_used: boolean;
  fallback_reason?: string;
  strategy_requested: ObservedResolutionStrategy;
  runtime: AgentType;
  recent_work_id: string;
  task_id?: string;
};

type ResolveObservedApprovalResult = {
  ok: boolean;
  approval_id: string;
  resolution: ResolutionPayload;
};

export function parseObservedApprovalId(approvalId: string): string | undefined {
  if (!approvalId.startsWith("observed-review:")) {
    return undefined;
  }

  const recentWorkId = approvalId.slice("observed-review:".length).trim();
  return recentWorkId.length > 0 ? recentWorkId : undefined;
}

export function normalizeResolutionStrategy(value: unknown): ObservedResolutionStrategy | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  if (value === "auto" || value === "in_place" || value === "managed_handoff") {
    return value;
  }

  return undefined;
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function inferRuntimeFromRecentWork(record: RecentWorkRecord): AgentType {
  return record.source_type.includes("claude") ? "claude-code" : "codex";
}

function buildManagedFallbackInstruction(
  approval: ObservedApprovalDetail | undefined,
  decision: "approved" | "rejected",
  note?: string,
): string {
  const normalizedNote = typeof note === "string" ? note.trim() : "";
  const action = typeof approval?.action === "string" ? approval.action.trim() : "";
  const context = typeof approval?.context === "string" ? approval.context.trim() : "";

  if (decision === "rejected") {
    return [
      "Do not execute the blocked observed action.",
      action ? `Blocked action: ${action}` : undefined,
      context ? `Reason/context: ${context}` : undefined,
      normalizedNote ? `Operator rejection note: ${normalizedNote}` : undefined,
      "Provide a safe alternative plan and stop before risky side effects.",
    ].filter((value): value is string => Boolean(value)).join(" ");
  }

  return [
    "Take over the observed approval and complete the blocked work in a managed session.",
    action ? `Blocked action: ${action}` : undefined,
    context ? `Observed context: ${context}` : undefined,
    normalizedNote ? `Operator note: ${normalizedNote}` : undefined,
    "Actually perform the requested operation before declaring completion.",
  ].filter((value): value is string => Boolean(value)).join(" ");
}

export class ObservedResolutionService {
  private readonly dashboard: DashboardService;
  private readonly recentWork: RecentWorkService;
  private readonly scheduler: SchedulerService;
  private readonly codexAdapter?: AgentAdapter;
  private readonly verificationTimeoutMs: number;
  private readonly verificationPollIntervalMs: number;

  constructor(input: {
    dashboard: DashboardService;
    recentWork: RecentWorkService;
    scheduler: SchedulerService;
    codexAdapter?: AgentAdapter;
    verificationTimeoutMs?: number;
    verificationPollIntervalMs?: number;
  }) {
    this.dashboard = input.dashboard;
    this.recentWork = input.recentWork;
    this.scheduler = input.scheduler;
    this.codexAdapter = input.codexAdapter;
    this.verificationTimeoutMs = Math.max(50, input.verificationTimeoutMs ?? 8000);
    this.verificationPollIntervalMs = Math.max(10, input.verificationPollIntervalMs ?? 400);
  }

  async resolve(input: ResolveObservedApprovalInput): Promise<ResolveObservedApprovalResult> {
    const recentWorkId = parseObservedApprovalId(input.approvalId);
    if (!recentWorkId) {
      throw new Error(`Approval ${input.approvalId} is not an observed approval`);
    }

    const approval = this.dashboard.getApprovalDetail(input.approvalId) as ObservedApprovalDetail | undefined;
    const record = this.recentWork.get(recentWorkId);
    if (!record) {
      throw new Error(`Recent work ${recentWorkId} not found`);
    }

    const runtime = inferRuntimeFromRecentWork(record);
    const strategy = input.resolutionStrategy;
    const inPlaceSupported = runtime === "codex" && Boolean(this.codexAdapter?.appendToConversation);
    const inPlaceUnsupportedReason = `in_place_not_supported_for_runtime:${runtime}`;

    if (strategy === "in_place" && !inPlaceSupported) {
      return {
        ok: false,
        approval_id: input.approvalId,
        resolution: {
          method: "none",
          status: "failed",
          fallback_used: false,
          fallback_reason: inPlaceUnsupportedReason,
          strategy_requested: strategy,
          runtime,
          recent_work_id: recentWorkId,
        },
      };
    }

    if ((strategy === "auto" || strategy === "in_place") && inPlaceSupported) {
      const prompt = this.buildCodexInPlacePrompt(approval, input.decision, input.note);
      try {
        await this.codexAdapter!.appendToConversation!(
          recentWorkId,
          prompt,
          {
            projectPath: record.project_path,
            modelPreference: undefined,
          },
        );

        const verification = input.requireVerification
          ? await this.verifyObservedResolution(input.approvalId, recentWorkId)
          : { verified: true };

        if (verification.verified) {
          return {
            ok: true,
            approval_id: input.approvalId,
            resolution: {
              method: "in_place",
              status: "verified",
              fallback_used: false,
              strategy_requested: strategy,
              runtime,
              recent_work_id: recentWorkId,
            },
          };
        }

        if (strategy === "in_place" || input.decision === "rejected") {
          return {
            ok: false,
            approval_id: input.approvalId,
            resolution: {
              method: "none",
              status: "failed",
              fallback_used: false,
              fallback_reason: `in_place_verification_failed:${verification.reason}`,
              strategy_requested: strategy,
              runtime,
              recent_work_id: recentWorkId,
            },
          };
        }
      } catch (error) {
        if (strategy === "in_place" || input.decision === "rejected") {
          return {
            ok: false,
            approval_id: input.approvalId,
            resolution: {
              method: "none",
              status: "failed",
              fallback_used: false,
              fallback_reason: `in_place_failed:${error instanceof Error ? error.message : "unknown_error"}`,
              strategy_requested: strategy,
              runtime,
              recent_work_id: recentWorkId,
            },
          };
        }
      }
    } else if (strategy === "auto" && input.decision === "rejected") {
      return {
        ok: false,
        approval_id: input.approvalId,
        resolution: {
          method: "none",
          status: "failed",
          fallback_used: false,
          fallback_reason: inPlaceUnsupportedReason,
          strategy_requested: strategy,
          runtime,
          recent_work_id: recentWorkId,
        },
      };
    }

    const shouldFallbackToManaged = strategy === "managed_handoff" || strategy === "auto";
    if (!shouldFallbackToManaged) {
      return {
        ok: false,
        approval_id: input.approvalId,
        resolution: {
          method: "none",
          status: "failed",
          fallback_used: false,
          fallback_reason: "unsupported_resolution_strategy",
          strategy_requested: strategy,
          runtime,
          recent_work_id: recentWorkId,
        },
      };
    }

    if (input.decision === "rejected") {
      return {
        ok: false,
        approval_id: input.approvalId,
        resolution: {
          method: "none",
          status: "failed",
          fallback_used: false,
          fallback_reason: "rejected_requires_in_place_bridge",
          strategy_requested: strategy,
          runtime,
          recent_work_id: recentWorkId,
        },
      };
    }

    const task = this.recentWork.continueRecentWork(
      recentWorkId,
      buildManagedFallbackInstruction(approval, input.decision, input.note),
    );
    void this.scheduler.tick();

    return {
      ok: true,
      approval_id: input.approvalId,
      resolution: {
        method: "managed_handoff",
        status: "queued",
        fallback_used: strategy === "auto",
        fallback_reason: strategy === "auto"
          ? (input.requireVerification ? "in_place_unavailable_or_unverified" : "in_place_unavailable")
          : undefined,
        strategy_requested: strategy,
        runtime,
        recent_work_id: recentWorkId,
        task_id: task.id,
      },
    };
  }

  private async verifyObservedResolution(approvalId: string, recentWorkId: string): Promise<{ verified: boolean; reason?: string }> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.verificationTimeoutMs) {
      this.recentWork.scan();

      const pendingApproval = this.dashboard.getApprovalDetail(approvalId);
      const record = this.recentWork.get(recentWorkId);
      const hasPendingReview = this.hasPendingObservedReview(record);
      if (!pendingApproval && !hasPendingReview) {
        return { verified: true };
      }

      await delay(this.verificationPollIntervalMs);
    }

    return {
      verified: false,
      reason: "timeout_waiting_for_observed_review_to_clear",
    };
  }

  private hasPendingObservedReview(record: RecentWorkRecord | undefined): boolean {
    const pending = record?.metadata?.pending_observed_review;
    return Boolean(pending && typeof pending === "object");
  }

  private buildCodexInPlacePrompt(
    approval: ObservedApprovalDetail | undefined,
    decision: "approved" | "rejected",
    note?: string,
  ): string {
    const action = pickString(approval?.action) ?? "Pending observed review";
    const context = pickString(approval?.context) ?? "No additional context was captured.";
    const operatorNote = pickString(note);

    return [
      "Buddy operator review decision for this observed thread.",
      "",
      `Decision: ${decision.toUpperCase()}`,
      `Action: ${action}`,
      `Context: ${context}`,
      operatorNote ? `Operator note: ${operatorNote}` : undefined,
      "",
      decision === "approved"
        ? "Resolve the pending review in this same thread and continue the originally blocked work."
        : "Reject the pending review in this same thread, do not run the blocked action, and provide a safe alternative.",
      "If the review is already resolved, confirm current status briefly.",
      "Return a short status update only.",
    ].filter((line): line is string => Boolean(line)).join("\n");
  }
}
