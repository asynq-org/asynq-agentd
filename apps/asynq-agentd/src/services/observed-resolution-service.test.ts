import assert from "node:assert/strict";
import test from "node:test";
import type { RecentWorkRecord, TaskRecord } from "../domain.ts";
import {
  normalizeResolutionStrategy,
  type ObservedApprovalBridge,
  ObservedResolutionService,
  parseObservedApprovalId,
} from "./observed-resolution-service.ts";

function createObservedRecentWork(id: string, pendingReview = false, sourceType: RecentWorkRecord["source_type"] = "codex-session-file"): RecentWorkRecord {
  return {
    id,
    source_path: "/tmp/session.jsonl",
    project_path: "/tmp/project",
    title: "Observed session",
    summary: "Pending approval in observed session",
    source_type: sourceType,
    status: "active",
    updated_at: new Date().toISOString(),
    metadata: pendingReview
      ? {
          pending_observed_review: {
            action: "Approve command: rm -rf ./build",
            context: "Approval is required before running a destructive command.",
          },
        }
      : {},
  };
}

test("parseObservedApprovalId parses observed approval ids", () => {
  assert.equal(parseObservedApprovalId("observed-review:recent_123"), "recent_123");
  assert.equal(parseObservedApprovalId("approval_123"), undefined);
});

test("normalizeResolutionStrategy validates known values", () => {
  assert.equal(normalizeResolutionStrategy("auto"), "auto");
  assert.equal(normalizeResolutionStrategy("managed_handoff"), "managed_handoff");
  assert.equal(normalizeResolutionStrategy("in_place"), "in_place");
  assert.equal(normalizeResolutionStrategy("invalid"), undefined);
});

test("observed resolution auto strategy resolves in place when verification succeeds", async () => {
  const relayCalls: Array<{ conversationId: string; prompt: string }> = [];
  const service = new ObservedResolutionService({
    dashboard: {
      getApprovalDetail: () => undefined,
    } as never,
    recentWork: {
      get: () => createObservedRecentWork("recent_observed_1", false),
      scan: () => {},
      continueRecentWork: () => {
        throw new Error("continueRecentWork should not be called when in-place succeeds");
      },
    } as never,
    scheduler: {
      tick: async () => {},
    } as never,
    codexAdapter: {
      name: "codex-cli",
      runTask: async () => {},
      appendToConversation: async (conversationId: string, prompt: string) => {
        relayCalls.push({ conversationId, prompt });
      },
    },
    codexInPlaceBridgeAvailable: true,
    verificationTimeoutMs: 80,
    verificationPollIntervalMs: 10,
  });

  const result = await service.resolve({
    approvalId: "observed-review:recent_observed_1",
    decision: "approved",
    note: "Proceed, then report outcome.",
    resolutionStrategy: "auto",
    requireVerification: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolution.method, "in_place");
  assert.equal(result.resolution.status, "verified");
  assert.equal(result.resolution.fallback_used, false);
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0]?.conversationId, "recent_observed_1");
  assert.match(relayCalls[0]?.prompt ?? "", /Decision: APPROVED/);
});

test("observed resolution auto strategy resolves with Codex GUI bridge when verification succeeds", async () => {
  const bridgeCalls: Array<{ decision: "approved" | "rejected"; action?: string }> = [];
  let approvalCleared = false;
  const bridge: ObservedApprovalBridge = {
    isAvailable: () => true,
    resolve: async (input) => {
      bridgeCalls.push({
        decision: input.decision,
        action: input.approval?.action,
      });
      approvalCleared = true;
    },
  };

  const service = new ObservedResolutionService({
    dashboard: {
      getApprovalDetail: () => approvalCleared
        ? undefined
        : {
            approval_id: "observed-review:recent_observed_bridge",
            action: "Approve command: node cleanup.js",
          },
    } as never,
    recentWork: {
      get: () => createObservedRecentWork("recent_observed_bridge", false),
      scan: () => {},
      continueRecentWork: () => {
        throw new Error("continueRecentWork should not be called when bridge succeeds");
      },
    } as never,
    scheduler: {
      tick: async () => {},
    } as never,
    codexBridge: bridge,
    verificationTimeoutMs: 80,
    verificationPollIntervalMs: 10,
  });

  const result = await service.resolve({
    approvalId: "observed-review:recent_observed_bridge",
    decision: "approved",
    resolutionStrategy: "auto",
    requireVerification: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolution.method, "codex_gui_bridge");
  assert.equal(result.resolution.status, "verified");
  assert.equal(result.resolution.fallback_used, false);
  assert.deepEqual(bridgeCalls, [{
    decision: "approved",
    action: "Approve command: node cleanup.js",
  }]);
});

test("observed resolution auto strategy falls back to managed handoff when Codex GUI bridge fails", async () => {
  let schedulerTicks = 0;
  let capturedInstruction = "";
  const bridge: ObservedApprovalBridge = {
    isAvailable: () => true,
    resolve: async () => {
      throw new Error("codex_gui_bridge_button_not_found");
    },
  };

  const service = new ObservedResolutionService({
    dashboard: {
      getApprovalDetail: () => ({
        approval_id: "observed-review:recent_observed_bridge_fallback",
        action: "Approve command: node cleanup.js",
      }),
    } as never,
    recentWork: {
      get: () => createObservedRecentWork("recent_observed_bridge_fallback", true),
      scan: () => {},
      continueRecentWork: (_id: string, instruction?: string) => {
        capturedInstruction = instruction ?? "";
        return { id: "task_takeover_bridge_fallback" } as TaskRecord;
      },
    } as never,
    scheduler: {
      tick: async () => {
        schedulerTicks += 1;
      },
    } as never,
    codexBridge: bridge,
    verificationTimeoutMs: 60,
    verificationPollIntervalMs: 10,
  });

  const result = await service.resolve({
    approvalId: "observed-review:recent_observed_bridge_fallback",
    decision: "approved",
    resolutionStrategy: "auto",
    requireVerification: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolution.method, "managed_handoff");
  assert.equal(result.resolution.status, "queued");
  assert.equal(result.resolution.fallback_used, true);
  assert.equal(result.resolution.task_id, "task_takeover_bridge_fallback");
  assert.equal(schedulerTicks, 1);
  assert.match(capturedInstruction, /Take over the observed approval/i);
});

test("observed resolution auto strategy falls back to managed handoff when verification times out", async () => {
  let schedulerTicks = 0;
  let capturedInstruction = "";

  const service = new ObservedResolutionService({
    dashboard: {
      getApprovalDetail: () => ({
        approval_id: "observed-review:recent_observed_1",
      }),
    } as never,
    recentWork: {
      get: () => createObservedRecentWork("recent_observed_1", true),
      scan: () => {},
      continueRecentWork: (_id: string, instruction?: string) => {
        capturedInstruction = instruction ?? "";
        return { id: "task_takeover_1" } as TaskRecord;
      },
    } as never,
    scheduler: {
      tick: async () => {
        schedulerTicks += 1;
      },
    } as never,
    codexAdapter: {
      name: "codex-cli",
      runTask: async () => {},
      appendToConversation: async () => {},
    },
    codexInPlaceBridgeAvailable: true,
    verificationTimeoutMs: 60,
    verificationPollIntervalMs: 10,
  });

  const result = await service.resolve({
    approvalId: "observed-review:recent_observed_1",
    decision: "approved",
    note: "Proceed, then report outcome.",
    resolutionStrategy: "auto",
    requireVerification: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolution.method, "managed_handoff");
  assert.equal(result.resolution.status, "queued");
  assert.equal(result.resolution.fallback_used, true);
  assert.equal(result.resolution.task_id, "task_takeover_1");
  assert.equal(result.resolution.fallback_reason, "in_place_unavailable_or_unverified");
  assert.equal(schedulerTicks, 1);
  assert.match(capturedInstruction, /Take over the observed approval/i);
  assert.match(capturedInstruction, /Operator note: Proceed, then report outcome\./i);
});

test("observed resolution auto strategy uses Codex resume continuation when no live bridge is available", async () => {
  let relayCalls = 0;
  let schedulerTicks = 0;
  let relayPrompt = "";

  const service = new ObservedResolutionService({
    dashboard: {
      getApprovalDetail: () => ({
        approval_id: "observed-review:recent_observed_default",
      }),
    } as never,
    recentWork: {
      get: () => createObservedRecentWork("recent_observed_default", true),
      scan: () => {},
      continueRecentWork: () => ({ id: "task_takeover_default" }) as TaskRecord,
      markResumeContinuationResolved: () => undefined,
      setContinuationApproval: () => {
        throw new Error("setContinuationApproval should not be called without NEXT_APPROVAL_REQUIRED");
      },
    } as never,
    scheduler: {
      tick: async () => {
        schedulerTicks += 1;
      },
    } as never,
    codexAdapter: {
      name: "codex-cli",
      runTask: async () => {},
      appendToConversation: async (_conversationId: string, prompt: string) => {
        relayCalls += 1;
        relayPrompt = prompt;
      },
    },
    verificationTimeoutMs: 60,
    verificationPollIntervalMs: 10,
  });

  const result = await service.resolve({
    approvalId: "observed-review:recent_observed_default",
    decision: "approved",
    resolutionStrategy: "auto",
    requireVerification: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolution.method, "codex_resume_continuation");
  assert.equal(result.resolution.fallback_used, true);
  assert.equal(result.resolution.fallback_reason, "live_bridge_unavailable_used_codex_resume_continuation");
  assert.equal(relayCalls, 1);
  assert.equal(schedulerTicks, 0);
  assert.match(relayPrompt, /same-thread continuation/i);
  assert.match(relayPrompt, /cancel that prompt instead of approving it/i);
  assert.match(relayPrompt, /Do not retry or re-request the original desktop approval/i);
  assert.match(relayPrompt, /different permission mode only for this run/i);
  assert.match(relayPrompt, /normal interactive approval settings/i);
});

test("observed resolution auto strategy uses Claude Code resume continuation when available", async () => {
  let relayCalls = 0;
  let relayPrompt = "";

  const service = new ObservedResolutionService({
    dashboard: {
      getApprovalDetail: () => ({
        approval_id: "observed-review:recent_claude_observed_default",
      }),
    } as never,
    recentWork: {
      get: () => createObservedRecentWork("recent_claude_observed_default", true, "claude-session"),
      scan: () => {},
      continueRecentWork: () => {
        throw new Error("continueRecentWork should not be called for Claude resume continuation");
      },
      markResumeContinuationResolved: () => undefined,
      setContinuationApproval: () => {
        throw new Error("setContinuationApproval should not be called without NEXT_APPROVAL_REQUIRED");
      },
    } as never,
    scheduler: {
      tick: async () => {},
    } as never,
    claudeAdapter: {
      name: "claude-cli",
      runTask: async () => {},
      appendToConversation: async (_conversationId: string, prompt: string) => {
        relayCalls += 1;
        relayPrompt = prompt;
      },
    },
    verificationTimeoutMs: 60,
    verificationPollIntervalMs: 10,
  });

  const result = await service.resolve({
    approvalId: "observed-review:recent_claude_observed_default",
    decision: "approved",
    resolutionStrategy: "auto",
    requireVerification: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolution.method, "claude_resume_continuation");
  assert.equal(result.resolution.fallback_used, true);
  assert.equal(result.resolution.fallback_reason, "live_bridge_unavailable_used_claude_resume_continuation");
  assert.equal(relayCalls, 1);
  assert.match(relayPrompt, /Claude Code thread/i);
  assert.match(relayPrompt, /same-thread continuation/i);
});

test("observed resolution stores next continuation approval from Codex resume output", async () => {
  let capturedApproval: { action: string; context: string; cmd?: string; source?: string } | undefined;

  const service = new ObservedResolutionService({
    dashboard: {
      getApprovalDetail: () => ({
        approval_id: "observed-review:recent_observed_next",
      }),
    } as never,
    recentWork: {
      get: () => createObservedRecentWork("recent_observed_next", true),
      scan: () => {},
      continueRecentWork: () => {
        throw new Error("continueRecentWork should not be called for Codex resume continuation");
      },
      markResumeContinuationResolved: () => {
        throw new Error("markResumeContinuationResolved should not be called when next approval is required");
      },
      setContinuationApproval: (_id: string, approval: { action: string; context: string; cmd?: string; source?: string }) => {
        capturedApproval = approval;
      },
    } as never,
    scheduler: {
      tick: async () => {},
    } as never,
    codexAdapter: {
      name: "codex-cli",
      runTask: async () => {},
      appendToConversation: async () => ({
        lastMessage: [
          "First step completed.",
          "NEXT_APPROVAL_REQUIRED",
          "Action: Approve command: touch /tmp/second-file",
          "Context: Need to create the second file requested by the test.",
          "Command: touch /tmp/second-file",
        ].join("\n"),
      }),
    },
    verificationTimeoutMs: 60,
    verificationPollIntervalMs: 10,
  });

  const result = await service.resolve({
    approvalId: "observed-review:recent_observed_next",
    decision: "approved",
    resolutionStrategy: "auto",
    requireVerification: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolution.method, "codex_resume_continuation");
  assert.deepEqual(capturedApproval && {
    action: capturedApproval.action,
    context: capturedApproval.context,
    cmd: capturedApproval.cmd,
    source: capturedApproval.source,
  }, {
    action: "Approve command: touch /tmp/second-file",
    context: "Need to create the second file requested by the test.",
    cmd: "touch /tmp/second-file",
    source: "codex_resume_continuation",
  });
});

test("observed resolution in_place strategy reports failure when in-place relay errors", async () => {
  const service = new ObservedResolutionService({
    dashboard: {
      getApprovalDetail: () => ({
        approval_id: "observed-review:recent_observed_2",
      }),
    } as never,
    recentWork: {
      get: () => createObservedRecentWork("recent_observed_2", true),
      scan: () => {},
      continueRecentWork: () => {
        throw new Error("continueRecentWork should not be called for in_place");
      },
    } as never,
    scheduler: {
      tick: async () => {},
    } as never,
    codexAdapter: {
      name: "codex-cli",
      runTask: async () => {},
      appendToConversation: async () => {
        throw new Error("network failure");
      },
    },
    codexInPlaceBridgeAvailable: true,
    verificationTimeoutMs: 60,
    verificationPollIntervalMs: 10,
  });

  const result = await service.resolve({
    approvalId: "observed-review:recent_observed_2",
    decision: "approved",
    resolutionStrategy: "in_place",
    requireVerification: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.resolution.method, "none");
  assert.equal(result.resolution.status, "failed");
  assert.match(result.resolution.fallback_reason ?? "", /^in_place_failed:/);
});

test("observed resolution in_place strategy fails when verification does not clear approval", async () => {
  const service = new ObservedResolutionService({
    dashboard: {
      getApprovalDetail: () => ({
        approval_id: "observed-review:recent_observed_3",
      }),
    } as never,
    recentWork: {
      get: () => createObservedRecentWork("recent_observed_3", true),
      scan: () => {},
      continueRecentWork: () => {
        throw new Error("continueRecentWork should not be called for in_place");
      },
    } as never,
    scheduler: {
      tick: async () => {},
    } as never,
    codexAdapter: {
      name: "codex-cli",
      runTask: async () => {},
      appendToConversation: async () => {},
    },
    codexInPlaceBridgeAvailable: true,
    verificationTimeoutMs: 60,
    verificationPollIntervalMs: 10,
  });

  const result = await service.resolve({
    approvalId: "observed-review:recent_observed_3",
    decision: "approved",
    resolutionStrategy: "in_place",
    requireVerification: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.resolution.method, "none");
  assert.equal(result.resolution.status, "failed");
  assert.match(result.resolution.fallback_reason ?? "", /^in_place_verification_failed:/);
});
