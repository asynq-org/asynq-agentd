import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AsynqAgentdStorage } from "../db/storage.ts";
import { ConfigService } from "./config-service.ts";

test("config service merges project approval and model routing defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-config-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const config = new ConfigService(storage);
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(resolve(projectRoot, ".asynq-agentd.yaml"), [
    "project:",
    "  approval:",
    "    timeout_minutes: 15",
    "  model_routing:",
    "    default: claude-opus",
    "",
  ].join("\n"));

  const effective = config.getEffective(projectRoot);
  assert.equal(effective.approval.timeout_minutes, 15);
  assert.equal(effective.model_routing.default, "claude-opus");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});
