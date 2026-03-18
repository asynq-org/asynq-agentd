import test from "node:test";
import assert from "node:assert/strict";
import { parseTerminalControlMessage } from "./server.ts";

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
