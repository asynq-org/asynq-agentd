import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsynqAgentdStorage } from "../db/storage.ts";
import { TerminalStreamService } from "./terminal-stream-service.ts";

test("terminal stream service broadcasts globally and per session", () => {
  const stream = new TerminalStreamService();
  const globalSeen: string[] = [];
  const scopedSeen: string[] = [];

  const unsubscribeGlobal = stream.subscribe((event) => {
    globalSeen.push(`${event.session_id}:${event.stream}:${event.chunk.trim()}`);
  });
  const unsubscribeScoped = stream.subscribe((event) => {
    scopedSeen.push(`${event.session_id}:${event.stream}:${event.chunk.trim()}`);
  }, "sess_1");

  stream.publish("sess_1", "stdout", "hello\n");
  stream.publish("sess_1", "stdin", "help\n");
  stream.publish("sess_2", "stderr", "boom\n");

  unsubscribeGlobal();
  unsubscribeScoped();

  assert.deepEqual(globalSeen, ["sess_1:stdout:hello", "sess_1:stdin:help", "sess_2:stderr:boom"]);
  assert.deepEqual(scopedSeen, ["sess_1:stdout:hello", "sess_1:stdin:help"]);
});

test("terminal stream service keeps bounded per-session history", () => {
  const stream = new TerminalStreamService(2);

  stream.publish("sess_1", "stdout", "one\n");
  stream.publish("sess_1", "stdout", "two\n");
  stream.publish("sess_1", "stderr", "three\n");

  assert.deepEqual(
    stream.list("sess_1", 10).map((event) => `${event.stream}:${event.chunk.trim()}`),
    ["stdout:two", "stderr:three"],
  );
  assert.deepEqual(stream.list("sess_1", 1).map((event) => event.chunk.trim()), ["three"]);
});

test("terminal stream service persists history through storage", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-terminal-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const writer = new TerminalStreamService(storage, 10);

  writer.publish("sess_1", "stdout", "hello\n");
  writer.publish("sess_1", "stderr", "boom\n");

  const reader = new TerminalStreamService(storage, 10);
  assert.deepEqual(
    reader.list("sess_1", 10).map((event) => `${event.stream}:${event.chunk.trim()}`),
    ["stdout:hello", "stderr:boom"],
  );

  storage.close();
  rmSync(root, { recursive: true, force: true });
});
