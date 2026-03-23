import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsynqAgentdStorage } from "../db/storage.ts";
import { createDefaultConfig } from "../config.ts";
import { SummaryService } from "./summary-service.ts";
import { RuntimeDiscoveryService } from "./runtime-discovery-service.ts";
import { EventStreamService } from "./event-stream-service.ts";

test("summary service caches provider-backed continue summaries and emits update events", async () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-summary-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const events = new EventStreamService();
  const seen: string[] = [];
  const unsubscribe = events.subscribe((event) => {
    seen.push(`${event.kind}:${event.session_id}`);
  });

  const summaries = new SummaryService({
    storage,
    events,
    runtimes: new RuntimeDiscoveryService(),
    getConfig: () => createDefaultConfig(),
    providers: [{
      id: "claude",
      isAvailable: () => true,
      summarize: async () => ({
        title: "Continue payments refactor",
        summary: "Resume the paused payments refactor and keep tests unchanged.",
      }),
    }],
  });

  const record = {
    id: "recent_1",
    source_path: "/tmp/recent.jsonl",
    project_path: "/tmp/demo",
    title: "Raw imported title",
    summary: "Raw imported summary",
    source_type: "claude-session" as const,
    status: "ended" as const,
    updated_at: new Date().toISOString(),
    metadata: {
      last_agent_message: "Please continue the payments refactor but avoid touching the tests.",
    },
  };

  const immediate = summaries.getContinueCard(record, record.title, record.summary ?? "");
  assert.equal(immediate.title, "Raw imported title");

  await new Promise((resolve) => setTimeout(resolve, 10));
  const cached = storage.getSummaryCache("continue_card:recent_1");
  assert.equal(cached?.provider, "claude");
  assert.equal(cached?.content.title, "Continue payments refactor");
  assert.ok(seen.includes("summary:recent_work:recent_1"));

  unsubscribe();
  storage.close();
  rmSync(root, { recursive: true, force: true });
});
