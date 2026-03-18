import test from "node:test";
import assert from "node:assert/strict";
import { EventStreamService } from "./event-stream-service.ts";

test("event stream service broadcasts globally and per session", () => {
  const events = new EventStreamService();
  const globalSeen: string[] = [];
  const scopedSeen: string[] = [];

  const unsubscribeGlobal = events.subscribe((event) => {
    globalSeen.push(`${event.kind}:${event.session_id}`);
  });
  const unsubscribeScoped = events.subscribe((event) => {
    scopedSeen.push(`${event.kind}:${event.session_id}`);
  }, "sess_1");

  events.publish({
    kind: "activity",
    session_id: "sess_1",
    created_at: "2026-03-16T12:00:00.000Z",
    payload: {
      type: "agent_thinking",
      summary: "Working",
    },
  });
  events.publish({
    kind: "session",
    session_id: "sess_2",
    created_at: "2026-03-16T12:00:01.000Z",
    payload: {
      state: "working",
      adapter: "codex-cli",
    },
  });

  unsubscribeGlobal();
  unsubscribeScoped();

  assert.deepEqual(globalSeen, ["activity:sess_1", "session:sess_2"]);
  assert.deepEqual(scopedSeen, ["activity:sess_1"]);
});
