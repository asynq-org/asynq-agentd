import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AsynqAgentdStorage } from "../db/storage.ts";
import { TaskService } from "./task-service.ts";
import { RecentWorkService } from "./recent-work-service.ts";
import { EventStreamService } from "./event-stream-service.ts";

function encodeClaudeProjectPath(projectPath: string): string {
  return projectPath.replace(/[\\/]/g, "-");
}

test("recent work scan indexes claude-like files and continue creates a task", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-recent-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const claudeRoot = resolve(root, ".claude");
  mkdirSync(claudeRoot, { recursive: true });
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const sessionFile = resolve(claudeRoot, "session.json");

  writeFileSync(sessionFile, JSON.stringify({
    title: "JWT refactor",
    projectPath: projectRoot,
    summary: "Continue fixing failing tests",
    status: "ended",
  }));

  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: claudeRoot,
    codexPath: resolve(root, ".codex-empty"),
  });
  const indexed = recentWork.scan();

  assert.equal(indexed.length, 1);
  assert.equal(indexed[0]?.title, "JWT refactor");
  assert.equal(recentWork.list().length, 1);

  const task = recentWork.continueRecentWork(indexed[0]!.id, "Fix the test failures");
  assert.equal(task.agent_type, "claude-code");
  assert.equal(task.project_path, projectRoot);
  assert.equal(task.context?.previous_session_id, indexed[0]!.id);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("recent work scan publishes an update event when imported work changes", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-recent-events-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const events = new EventStreamService();
  const published: string[] = [];
  const claudeRoot = resolve(root, ".claude");
  const projectRoot = resolve(root, "project");
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const sessionFile = resolve(claudeRoot, "session.json");

  events.subscribe((event) => {
    if (event.kind === "summary" && event.payload.entity_type === "recent_work") {
      published.push(event.payload.entity_id);
    }
  });

  writeFileSync(sessionFile, JSON.stringify({
    title: "JWT refactor",
    projectPath: projectRoot,
    summary: "Continue fixing failing tests",
    status: "ended",
  }));

  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: claudeRoot,
    codexPath: resolve(root, ".codex-empty"),
    events,
  });

  const firstScan = recentWork.scan();
  assert.equal(firstScan.length, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0], firstScan[0]?.id);

  recentWork.scan();
  assert.equal(published.length, 1);

  writeFileSync(sessionFile, JSON.stringify({
    title: "JWT refactor",
    projectPath: projectRoot,
    summary: "Continue fixing failing tests and finish middleware cleanup",
    status: "ended",
  }));

  recentWork.scan();
  assert.equal(published.length, 2);
  assert.equal(published[1], firstScan[0]?.id);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("recent work scan parses real Claude session metadata and transcripts", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-claude-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const claudeRoot = resolve(root, ".claude");
  const projectRoot = resolve(root, "myproject");
  mkdirSync(projectRoot, { recursive: true });

  // Encode project path like Claude does: /foo/bar -> -foo-bar
  const encodedProjectPath = encodeClaudeProjectPath(projectRoot);
  const sessionsDir = resolve(claudeRoot, "sessions");
  const projectsDir = resolve(claudeRoot, "projects", encodedProjectPath);
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });

  const sessionId = "abc12345-dead-beef-cafe-111122223333";

  // Write session metadata (simulates an active session)
  writeFileSync(resolve(sessionsDir, "99999.json"), JSON.stringify({
    pid: 99999,
    sessionId,
    cwd: projectRoot,
    startedAt: Date.now() - 60_000,
  }));

  // Write transcript
  writeFileSync(resolve(projectsDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: "file-history-snapshot",
      messageId: "msg-1",
      snapshot: { messageId: "msg-1", trackedFileBackups: {}, timestamp: "2026-03-16T10:00:00.000Z" },
      isSnapshotUpdate: false,
    }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "Fix the auth middleware" },
      uuid: "msg-1",
      timestamp: "2026-03-16T10:00:00.000Z",
      cwd: projectRoot,
      sessionId,
      version: "2.1.76",
      gitBranch: "feature/auth-fix",
    }),
    JSON.stringify({
      parentUuid: "msg-1",
      isSidechain: false,
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need to look at the auth middleware code first." },
          { type: "text", text: "I'll start by reading the auth middleware." },
        ],
      },
      uuid: "msg-2",
      timestamp: "2026-03-16T10:00:05.000Z",
      cwd: projectRoot,
      sessionId,
      gitBranch: "feature/auth-fix",
    }),
    JSON.stringify({
      parentUuid: "msg-2",
      isSidechain: false,
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "/src/middleware/auth.ts" },
          },
        ],
      },
      uuid: "msg-3",
      timestamp: "2026-03-16T10:00:06.000Z",
      sessionId,
    }),
    JSON.stringify({
      parentUuid: "msg-3",
      isSidechain: false,
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Edit",
            input: { file_path: "/src/middleware/auth.ts", old_string: "old", new_string: "new" },
          },
        ],
      },
      uuid: "msg-4",
      timestamp: "2026-03-16T10:00:10.000Z",
      sessionId,
    }),
    JSON.stringify({
      parentUuid: "msg-4",
      isSidechain: false,
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_3",
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
      },
      uuid: "msg-5",
      timestamp: "2026-03-16T10:00:15.000Z",
      sessionId,
    }),
    JSON.stringify({
      parentUuid: "msg-5",
      isSidechain: false,
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        role: "assistant",
        content: [
          { type: "text", text: "The auth middleware has been fixed. All tests pass." },
        ],
      },
      uuid: "msg-6",
      timestamp: "2026-03-16T10:00:20.000Z",
      sessionId,
    }),
    "",
  ].join("\n"));

  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: claudeRoot,
    codexPath: resolve(root, ".codex-empty"),
  });
  const indexed = recentWork.scan();

  const claudeRecord = indexed.find((r) => r.id === sessionId);
  assert.ok(claudeRecord);
  assert.equal(claudeRecord?.source_type, "claude-session");
  assert.equal(claudeRecord?.project_path, projectRoot);
  assert.equal(claudeRecord?.title, "Fix the auth middleware");
  assert.equal(claudeRecord?.summary, "The auth middleware has been fixed. All tests pass.");
  assert.equal(claudeRecord?.status, "active"); // session meta exists
  assert.equal(claudeRecord?.metadata?.git_branch, "feature/auth-fix");
  assert.equal(claudeRecord?.metadata?.model, "claude-opus-4-6");
  assert.equal(claudeRecord?.metadata?.user_message_count, 1);
  assert.equal(claudeRecord?.metadata?.assistant_message_count, 2); // text messages only
  assert.equal(claudeRecord?.metadata?.tool_use_count, 3);
  assert.ok(Array.isArray(claudeRecord?.metadata?.files_modified));
  assert.ok((claudeRecord?.metadata?.files_modified as string[]).includes("/src/middleware/auth.ts"));

  // Test activity parsing
  const activity = recentWork.listImportedActivity(sessionId);
  assert.ok(activity.length > 0);
  assert.ok(activity.some((e) => e.payload.type === "agent_thinking"));
  assert.ok(activity.some((e) => e.payload.type === "command_run"));
  assert.ok(activity.some((e) => e.payload.type === "file_edit"));

  const bashEvent = activity.find((e) => e.payload.type === "command_run" && e.payload.cmd === "pnpm test");
  assert.ok(bashEvent);

  const editEvent = activity.find((e) => e.payload.type === "file_edit" && e.payload.path === "/src/middleware/auth.ts");
  assert.ok(editEvent);

  // Test continuation creates a task with rich context
  const task = recentWork.continueRecentWork(sessionId, "Continue the auth work");
  assert.equal(task.agent_type, "claude-code");
  assert.equal(task.project_path, projectRoot);
  assert.match(task.description, /Last user request: Fix the auth middleware/);
  assert.match(task.description, /Last assistant update: The auth middleware has been fixed/);
  assert.match(task.description, /Git branch: feature\/auth-fix/);
  assert.ok(task.context?.files_to_focus?.includes("/src/middleware/auth.ts"));

  // Test activity preview in list
  const listed = recentWork.list({ includeActivityPreview: true, previewLimit: 3 });
  const listedClaude = listed.find((r) => r.id === sessionId);
  assert.ok(listedClaude?.activity_preview);
  assert.ok(listedClaude!.activity_preview!.length > 0);
  assert.ok(listedClaude!.activity_preview!.length <= 3);

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("Claude transcript with last-prompt marker is detected as ended", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-claude-ended-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const claudeRoot = resolve(root, ".claude");
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });

  const encodedProjectPath = encodeClaudeProjectPath(projectRoot);
  const projectsDir = resolve(claudeRoot, "projects", encodedProjectPath);
  mkdirSync(projectsDir, { recursive: true });

  const sessionId = "ended-session-1234";

  // No session metadata file = not active
  writeFileSync(resolve(projectsDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "Hello world" },
      uuid: "u1",
      timestamp: "2026-03-16T08:00:00.000Z",
      cwd: projectRoot,
      sessionId,
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
      },
      uuid: "a1",
      timestamp: "2026-03-16T08:00:05.000Z",
      sessionId,
    }),
    JSON.stringify({
      type: "last-prompt",
      lastPrompt: "Hello world",
      sessionId,
    }),
    "",
  ].join("\n"));

  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: claudeRoot,
    codexPath: resolve(root, ".codex-empty"),
  });
  const indexed = recentWork.scan();

  const record = indexed.find((r) => r.id === sessionId);
  assert.ok(record);
  assert.equal(record?.status, "ended");
  assert.equal(record?.title, "Hello world");
  assert.equal(record?.summary, "Hi there!");
  assert.equal(record?.metadata?.model, "claude-sonnet-4-6");

  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test("recent work scan indexes Codex session index and session files", () => {
  const root = mkdtempSync(join(tmpdir(), "asynq-agentd-recent-"));
  const storage = new AsynqAgentdStorage(join(root, "test.sqlite"));
  const tasks = new TaskService(storage);
  const codexRoot = resolve(root, ".codex");
  const sessionsRoot = resolve(codexRoot, "sessions", "2026", "03", "14");
  mkdirSync(sessionsRoot, { recursive: true });
  const projectRoot = resolve(root, "project");
  mkdirSync(projectRoot, { recursive: true });

  writeFileSync(resolve(codexRoot, "session_index.jsonl"), [
    JSON.stringify({
      id: "codex-session-1",
      thread_name: "Implement recent work parsing",
      updated_at: "2026-03-14T09:00:00.000Z",
    }),
    "",
  ].join("\n"));

  writeFileSync(resolve(sessionsRoot, "rollout-2026-03-14-codex-session-1.jsonl"), [
    JSON.stringify({
      timestamp: "2026-03-14T09:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "codex-session-1",
        cwd: projectRoot,
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-14T09:00:10.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-14T09:00:20.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Implement recent work parsing",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-14T09:00:25.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: ["Inspecting local Codex session files"],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-14T09:00:30.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "I found the session metadata and will wire it into recent-work.",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-14T09:00:35.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_exec_1",
        arguments: JSON.stringify({
          cmd: "pnpm test",
          workdir: projectRoot,
        }),
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-14T09:00:36.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_exec_1",
        output: "Chunk ID: demo\nWall time: 0.321 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\nTests passed\nℹ pass 12\nℹ fail 0\nℹ skipped 1\n",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-14T09:00:37.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        status: "completed",
        call_id: "call_patch_1",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: /tmp/example.ts\n@@\n-console.log('before');\n+console.log('after');\n*** Add File: /tmp/new-example.ts\n+export const created = true;\n*** Delete File: /tmp/old-example.ts\n*** End Patch\n",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-14T09:00:38.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_patch_1",
        output: JSON.stringify({
          output: "Success. Updated the following files:\nM /tmp/example.ts\n",
          metadata: {
            exit_code: 0,
            duration_seconds: 0.01,
          },
        }),
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-14T09:00:39.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1200,
            output_tokens: 200,
            reasoning_output_tokens: 21,
            total_tokens: 4321,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-14T09:00:40.000Z",
      type: "event_msg",
      payload: {
        type: "context_compacted",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-14T09:00:41.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
      },
    }),
    "",
  ].join("\n"));

  const recentWork = new RecentWorkService(storage, tasks, {
    claudePath: resolve(root, ".claude-empty"),
    codexPath: codexRoot,
  });
  const indexed = recentWork.scan();
  const codexRecord = indexed.find((record) => record.id === "codex-session-1" && record.source_type === "codex-session-file");

  assert.ok(codexRecord);
  assert.equal(codexRecord?.project_path, projectRoot);
  assert.equal(codexRecord?.status, "ended");
  assert.equal(codexRecord?.summary, "I found the session metadata and will wire it into recent-work.");
  assert.equal(codexRecord?.metadata?.last_user_message, "Implement recent work parsing");
  assert.equal(codexRecord?.metadata?.last_agent_message, "I found the session metadata and will wire it into recent-work.");
  assert.equal(codexRecord?.metadata?.last_reasoning_summary, "Inspecting local Codex session files");
  assert.equal(codexRecord?.metadata?.total_tokens, 4321);
  assert.equal(recentWork.get("codex-session-1")?.source_type, "codex-session-file");

  const task = recentWork.continueRecentWork("codex-session-1");
  assert.equal(task.agent_type, "codex");
  assert.match(task.description, /Recent summary:/);
  assert.match(task.description, /Last user request: Implement recent work parsing/);
  assert.match(task.description, /Last agent update: I found the session metadata and will wire it into recent-work\./);
  assert.ok(task.context?.files_to_focus?.includes(projectRoot));

  const activity = recentWork.listImportedActivity("codex-session-1");
  const rawActivity = recentWork.listImportedActivity("codex-session-1", undefined, false);
  const listedWithoutPreview = recentWork.list();
  const listedWithPreview = recentWork.list({ includeActivityPreview: true, previewLimit: 2 });
  const listedWithExpandedPreview = recentWork.list({ includeActivityPreview: true, previewLimit: 20 });
  const listedWithRawPreview = recentWork.list({ includeActivityPreview: true, previewLimit: 20, compact: false });
  const listedWithFilteredPreview = recentWork.list({
    includeActivityPreview: true,
    previewLimit: 20,
    previewTypes: ["file_batch", "agent_thinking"],
  });
  assert.ok(activity.length >= 7);
  assert.ok(rawActivity.length > activity.length);
  assert.equal(listedWithoutPreview.find((record) => record.id === "codex-session-1")?.activity_preview, undefined);
  assert.equal(listedWithPreview.find((record) => record.id === "codex-session-1")?.activity_preview?.length, 2);
  assert.ok(listedWithExpandedPreview.find((record) => record.id === "codex-session-1")?.activity_preview?.some((event) => event.payload.type === "file_batch"));
  assert.ok(listedWithRawPreview.find((record) => record.id === "codex-session-1")?.activity_preview?.some((event) => event.payload.type === "file_edit"));
  assert.ok(listedWithFilteredPreview.find((record) => record.id === "codex-session-1")?.activity_preview?.every((event) =>
    event.payload.type === "file_batch" || event.payload.type === "agent_thinking"
  ));
  assert.equal(activity[0]?.session_id, "codex-session-1");
  assert.ok(activity.some((event) => event.payload.type === "model_call"));
  assert.ok(activity.some((event) => event.payload.type === "agent_thinking"));
  assert.ok(activity.some((event) => event.payload.type === "session_state_change"));
  assert.ok(activity.some((event) => event.payload.type === "command_run"));
  assert.ok(activity.some((event) => event.payload.type === "test_run"));
  assert.ok(activity.some((event) => event.payload.type === "file_batch"));

  const commandEvent = activity.find((event) => event.payload.type === "command_run" && event.payload.cmd === "pnpm test");
  assert.ok(commandEvent);
  assert.equal(commandEvent?.payload.exit_code, 0);
  assert.equal(commandEvent?.payload.duration_ms, 321);
  assert.match(commandEvent?.payload.stdout_preview ?? "", /Tests passed/);

  const testRunEvent = activity.find((event) => event.payload.type === "test_run");
  assert.ok(testRunEvent);
  assert.equal(testRunEvent?.payload.passed, 12);
  assert.equal(testRunEvent?.payload.failed, 0);
  assert.equal(testRunEvent?.payload.skipped, 1);
  assert.equal(testRunEvent?.payload.duration_ms, 321);

  const fileBatchEvent = activity.find((event) => event.payload.type === "file_batch");
  assert.ok(fileBatchEvent);
  assert.match(fileBatchEvent?.payload.summary ?? "", /Updated files:/);
  assert.deepEqual(fileBatchEvent?.payload.files, [
    {
      path: "/tmp/example.ts",
      action: "edited",
      lines_added: 1,
      lines_removed: 1,
    },
    {
      path: "/tmp/new-example.ts",
      action: "created",
    },
    {
      path: "/tmp/old-example.ts",
      action: "deleted",
    },
  ]);

  assert.ok(rawActivity.some((event) => event.payload.type === "file_edit"));
  assert.ok(rawActivity.some((event) => event.payload.type === "file_create"));
  assert.ok(rawActivity.some((event) => event.payload.type === "file_delete"));
  assert.ok(!rawActivity.some((event) => event.payload.type === "file_batch"));

  storage.close();
  rmSync(root, { recursive: true, force: true });
});
