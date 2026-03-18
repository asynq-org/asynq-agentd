import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalPolicyService } from "./approval-policy-service.ts";
import { createDefaultConfig } from "../config.ts";
import type { TaskRecord } from "../domain.ts";

function createTask(): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "task_approval",
    title: "Approval policy probe",
    description: "Check runtime approval policy decisions.",
    agent_type: "custom",
    project_path: "/tmp/project",
    priority: "normal",
    depends_on: [],
    approval_required: false,
    status: "queued",
    created_at: now,
    updated_at: now,
  };
}

test("approval policy flags configured dangerous commands and model spend", () => {
  const policy = new ApprovalPolicyService();
  const config = createDefaultConfig();
  const task = createTask();

  const commandDecision = policy.shouldRequireApproval({
    type: "command_run",
    cmd: "git push origin main",
    exit_code: 0,
    duration_ms: 5,
  }, task, config);
  assert.ok(commandDecision);
  assert.match(commandDecision?.action ?? "", /git push/i);

  const modelDecision = policy.shouldRequireApproval({
    type: "model_call",
    model: "claude-opus",
    tokens_in: 1000,
    tokens_out: 2000,
    cost_usd: config.approval.cost_threshold,
  }, task, config);
  assert.ok(modelDecision);
});

test("approval policy ignores explicitly allowed commands", () => {
  const policy = new ApprovalPolicyService();
  const config = createDefaultConfig();
  const task = createTask();

  const decision = policy.shouldRequireApproval({
    type: "command_run",
    cmd: "npm test",
    exit_code: 0,
    duration_ms: 10,
  }, task, config);

  assert.equal(decision, undefined);
});

test("approval policy flags dangerous command intents and file deletion intents", () => {
  const policy = new ApprovalPolicyService();
  const config = createDefaultConfig();
  const task = createTask();

  const commandDecision = policy.shouldRequireApproval({
    type: "command_intent",
    cmd: "git push origin main",
    source: "tool_call",
  }, task, config);
  assert.ok(commandDecision);
  assert.match(commandDecision?.context ?? "", /about to run/i);

  const fileDecision = policy.shouldRequireApproval({
    type: "file_batch_intent",
    summary: "About to modify 2 files",
    files: [
      { path: "/tmp/keep.ts", action: "edited", lines_added: 2, lines_removed: 1 },
      { path: "/tmp/delete.ts", action: "deleted" },
    ],
  }, task, config);
  assert.ok(fileDecision);
  assert.match(fileDecision?.action ?? "", /upcoming file batch/i);
});
