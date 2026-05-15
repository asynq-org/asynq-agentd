import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  audioMimeTypeToExtension,
  decodePathSegment,
  listRecentProjectOptions,
  listWorkspaceProjectOptions,
  mergeProjectOptions,
  parseTerminalControlMessage,
  pickSourceCodexSessionId,
  resolveAudioTranscriptionConfig,
  sanitizeAudioName,
} from "./server.ts";

test("decodePathSegment decodes URL-encoded approval ids", () => {
  assert.equal(
    decodePathSegment("observed-review%3A019d9169-ff7c-71d0-9ba2-82c2caebdf99"),
    "observed-review:019d9169-ff7c-71d0-9ba2-82c2caebdf99",
  );
  assert.equal(decodePathSegment("%E0%A4%A"), "%E0%A4%A");
});

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

test("audioMimeTypeToExtension maps common recording formats", () => {
  assert.equal(audioMimeTypeToExtension("audio/mp4"), ".m4a");
  assert.equal(audioMimeTypeToExtension("audio/wav"), ".wav");
  assert.equal(audioMimeTypeToExtension("audio/mpeg"), ".mp3");
});

test("sanitizeAudioName normalizes unsafe characters", () => {
  assert.equal(
    sanitizeAudioName("Prompt note (CZ).m4a", 0, "audio/mp4"),
    "01-Prompt-note-CZ-.m4a",
  );
  assert.equal(
    sanitizeAudioName(undefined, 1, "audio/wav"),
    "02-prompt-2.wav",
  );
});

test("listWorkspaceProjectOptions returns direct subdirectories", () => {
  const root = resolve(tmpdir(), `asynq-agentd-projects-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(resolve(root, "zeta"), { recursive: true });
  mkdirSync(resolve(root, "alpha"), { recursive: true });
  mkdirSync(resolve(root, ".hidden"), { recursive: true });
  writeFileSync(resolve(root, "notes.txt"), "not a project\n", "utf8");

  try {
    assert.deepEqual(
      listWorkspaceProjectOptions(root).map((item) => ({ name: item.name, path: item.path, source: item.source })),
      [
        { name: "alpha", path: resolve(root, "alpha"), source: "workspace" },
        { name: "zeta", path: resolve(root, "zeta"), source: "workspace" },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recent project options deduplicate by newest use and merge with workspace options", () => {
  const alpha = resolve(tmpdir(), "alpha");
  const beta = resolve(tmpdir(), "beta");

  const recent = listRecentProjectOptions([
    { project_path: alpha, updated_at: "2026-01-02T00:00:00.000Z" },
    { project_path: alpha, updated_at: "2026-01-03T00:00:00.000Z" },
    { project_path: beta, updated_at: "2026-01-01T00:00:00.000Z" },
  ]);

  assert.deepEqual(recent.map((item) => [item.path, item.last_used_at]), [
    [alpha, "2026-01-03T00:00:00.000Z"],
    [beta, "2026-01-01T00:00:00.000Z"],
  ]);

  assert.deepEqual(
    mergeProjectOptions([
      { name: "alpha", path: alpha, source: "workspace" },
      ...recent,
    ]).map((item) => ({ path: item.path, source: item.source, lastUsedAt: item.last_used_at })),
    [
      { path: alpha, source: "workspace", lastUsedAt: "2026-01-03T00:00:00.000Z" },
      { path: beta, source: "recent", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ],
  );
});

test("resolveAudioTranscriptionConfig prefers explicit model path", () => {
  const config = resolveAudioTranscriptionConfig(
    {
      ASYNQ_AGENTD_WHISPER_MODEL: "/models/custom.bin",
      ASYNQ_AGENTD_WHISPER_BIN: "/opt/bin/whisper-cli",
      ASYNQ_AGENTD_FFMPEG_BIN: "/opt/bin/ffmpeg",
      ASYNQ_AGENTD_WHISPER_LANGUAGE: "cs",
    },
    (path) => path === "/models/custom.bin",
  );

  assert.equal(config.modelPath, "/models/custom.bin");
  assert.equal(config.whisperBin, "/opt/bin/whisper-cli");
  assert.equal(config.ffmpegBin, "/opt/bin/ffmpeg");
  assert.equal(config.language, "cs");
});

test("resolveAudioTranscriptionConfig rejects missing Whisper model", () => {
  assert.throws(
    () => resolveAudioTranscriptionConfig({}, () => false),
    /ASYNQ_AGENTD_WHISPER_MODEL/,
  );
});
