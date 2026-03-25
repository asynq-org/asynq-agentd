import test from "node:test";
import assert from "node:assert/strict";
import { parseTerminalControlMessage, pickSourceCodexSessionId } from "./server.ts";

test("parseTerminalControlMessage accepts send_message payloads", () => {
  assert.deepEqual(
    parseTerminalControlMessage(JSON.stringify({
      type: "send_message",
      message: "Please continue with the auth refactor.",
    })),
    {
      type: "send_message",
      message: "Please continue with the auth refactor.",
    },
  );
});

test("parseTerminalControlMessage accepts stdin payloads", () => {
  assert.deepEqual(
    parseTerminalControlMessage(JSON.stringify({
      type: "stdin",
      data: "yes\n",
    })),
    {
      type: "stdin",
      data: "yes\n",
    },
  );
});

test("parseTerminalControlMessage accepts resize payloads", () => {
  assert.deepEqual(
    parseTerminalControlMessage(JSON.stringify({
      type: "resize",
      cols: 120,
      rows: 40,
    })),
    {
      type: "resize",
      cols: 120,
      rows: 40,
    },
  );
});

test("parseTerminalControlMessage accepts stop payloads", () => {
  assert.deepEqual(
    parseTerminalControlMessage(JSON.stringify({
      type: "stop",
    })),
    {
      type: "stop",
    },
  );
});

test("parseTerminalControlMessage rejects unsupported payloads", () => {
  assert.throws(
    () => parseTerminalControlMessage(JSON.stringify({
      type: "unknown",
    })),
    /Unsupported terminal control message/,
  );
});

test("pickSourceCodexSessionId falls back to the observed Codex recent-work id", () => {
  assert.equal(
    pickSourceCodexSessionId(
      {
        context: {
          source_recent_work_id: "ignored",
        },
      } as never,
      {
        id: "019d2180-9a38-79c3-bd7c-d602b0277379",
        source_type: "codex-session-file",
      },
    ),
    "019d2180-9a38-79c3-bd7c-d602b0277379",
  );
});

test("pickSourceCodexSessionId preserves explicit task context when present", () => {
  assert.equal(
    pickSourceCodexSessionId(
      {
        context: {
          source_codex_session_id: "explicit-session-id",
        },
      } as never,
      {
        id: "019d2180-9a38-79c3-bd7c-d602b0277379",
        source_type: "codex-session-file",
      },
    ),
    "explicit-session-id",
  );
});
