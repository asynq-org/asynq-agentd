import assert from "node:assert/strict";
import test from "node:test";
import type { RecentWorkRecord, TaskRecord } from "../domain.ts";
import {
  normalizeResolutionStrategy,
  ObservedResolutionService,
  parseObservedApprovalId,
} from "./observed-resolution-service.ts";

function createObservedRecentWork(id: string, pendingReview = false): RecentWorkRecord {
  return {
    id,
    source_path: "/tmp/session.jsonl",
    project_path: "/tmp/project",
    title: "Observed session",
    summary: "Pending approval in observed session",
    source_type: "codex-session-file",
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
