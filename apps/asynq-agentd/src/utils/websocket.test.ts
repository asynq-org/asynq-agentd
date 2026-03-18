import test from "node:test";
import assert from "node:assert/strict";
import {
  createWebSocketAccept,
  encodeWebSocketPongFrame,
  encodeWebSocketTextFrame,
  parseWebSocketFrames,
} from "./websocket.ts";

test("websocket accept key matches RFC example", () => {
  assert.equal(
    createWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
});

test("websocket text frame encodes payload", () => {
  const frame = encodeWebSocketTextFrame("hello");
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 5);
  assert.equal(frame.subarray(2).toString("utf8"), "hello");
});

test("websocket parser decodes masked frames", () => {
  const payload = Buffer.from("ping", "utf8");
  const mask = Buffer.from([1, 2, 3, 4]);
  const maskedPayload = Buffer.from(payload);
  for (let index = 0; index < maskedPayload.length; index += 1) {
    maskedPayload[index] ^= mask[index % 4] ?? 0;
  }

  const frame = Buffer.concat([
    Buffer.from([0x89, 0x80 | payload.length]),
    mask,
    maskedPayload,
  ]);

  const parsed = parseWebSocketFrames(frame);
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.frames[0]?.opcode, 0x9);
  assert.equal(parsed.frames[0]?.payload.toString("utf8"), "ping");
  assert.equal(parsed.remaining.length, 0);
});

test("websocket pong frame reuses payload", () => {
  const frame = encodeWebSocketPongFrame(Buffer.from("ok", "utf8"));
  assert.equal(frame[0], 0x8A);
  assert.equal(frame.subarray(2).toString("utf8"), "ok");
});
