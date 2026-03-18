import test from "node:test";
import assert from "node:assert/strict";
import { ProcessMonitorService } from "./process-monitor-service.ts";

test("process monitor rejects invalid pids", () => {
  const monitor = new ProcessMonitorService();
  assert.equal(monitor.isAlive(undefined), false);
  assert.equal(monitor.isAlive(0), false);
  assert.equal(monitor.isAlive(-1), false);
});
