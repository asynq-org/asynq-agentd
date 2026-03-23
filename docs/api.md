# API contract

This page documents the current public-facing daemon contract for HTTP, SSE, and WebSocket integrations.

It is not a formal OpenAPI schema yet, but it is intended to be the practical contract for external tooling and the future Buddy UI.

## Auth

All non-public routes require:

```http
Authorization: Bearer <auth_token>
```

Public routes:

- `GET /`
- `GET /health`

## Core HTTP endpoints

### Health and identity

- `GET /`
  Returns daemon name, status, and bootstrap version.
- `GET /health`
  Returns `{ "ok": true }`.

### Sessions

- `GET /sessions`
- `GET /sessions/:id`
- `POST /sessions/:id/message`
- `DELETE /sessions/:id`
- `GET /sessions/:id/terminal?limit=200`
- `GET /sessions/:id/events/stream` (SSE)

`POST /sessions/:id/message` body:

```json
{
  "message": "Continue, but do not edit CI config."
}
```

### Tasks

- `GET /tasks`
- `POST /tasks`
- `PATCH /tasks/:id`
- `DELETE /tasks/:id`

Example `POST /tasks` body:

```json
{
  "title": "Refactor auth middleware",
  "description": "Start with the middleware and keep tests green.",
  "agent_type": "claude-code",
  "project_path": "/absolute/path/to/repo",
  "approval_required": true,
  "priority": "high",
  "schedule": "0 2 * * *",
  "context": {
    "files_to_focus": ["src/auth.ts"],
    "test_command": "pnpm test"
  }
}
```

Important notes:

- `project_path` must be absolute.
- `agent_type` is one of `claude-code`, `codex`, `opencode`, or `custom`.
- `priority` is one of `low`, `normal`, `high`, `urgent`.

### Approvals

- `GET /approvals`
- `GET /approvals?status=pending`
- `GET /approvals/:id`
- `POST /approvals/:id`

Approval resolution body:

```json
{
  "decision": "approved",
  "note": "Looks good, continue."
}
```

`GET /approvals/:id` returns the same core approval card shape used by the dashboard, plus a `review` object when the daemon can infer file-level review context from recent activity.

### Activity

- `GET /activity`
- `GET /activity?session=<session_id>`
- `GET /activity?type=command_run`
- `GET /activity?limit=50`
- `GET /activity?recent_work=<recent_work_id>`
- `GET /activity?recent_work=<recent_work_id>&compact=false`

Imported recent-work activity reuses the same activity payload model as daemon-managed sessions.

### Config

- `GET /config`
- `GET /config?project_path=/absolute/path/to/repo`
- `PATCH /config`

`GET /config` redacts `auth_token`.

### Stats

- `GET /stats`

### Recent work

- `GET /recent-work`
- `GET /recent-work?include_activity_preview=true`
- `GET /recent-work?include_activity_preview=true&activity_preview_limit=3`
- `GET /recent-work?include_activity_preview=true&preview_types=file_batch,agent_thinking`
- `GET /recent-work?include_activity_preview=true&compact=false`
- `POST /recent-work/:id/continue`

Continue body:

```json
{
  "instruction": "Continue, but do not change tests yet."
}
```

### Dashboard endpoints

- `GET /dashboard/overview`
- `GET /dashboard/attention-required`
- `GET /dashboard/continue-working`

These are the recommended backend contract for a Buddy-style dashboard client.

## Dashboard contract

### `GET /dashboard/overview`

Returns:

- `generated_at`
- `counts`
- `runtimes`
- `sessions`
- `attention_required`
- `continue_working`

The intent is to provide enough data for a home screen without multiple round trips.

`counts` currently includes:

- `sessions_active`
- `sessions_working`
- `approvals_pending`
- `tasks_running`
- `tasks_paused`
- `runtimes_ready`

`runtimes[]` reflects daemon-detected runtime readiness for adapters such as Claude Code and Codex, so clients can show “ready runtimes” even when no daemon-managed session is currently running.

### `GET /dashboard/attention-required`

Returns:

- `generated_at`
- `items[]`

Each item is an approval-oriented card with:

- `approval_id`
- `session_id`
- `task_id`
- `title`
- `action`
- `context`
- `agent_type`
- `project_path`
- `summary`
- `next_action`
- `created_at`
- `review`

`review` currently includes:

- `machine`
- `agent`
- `branch`
- `project`
- `review_hint`
- `test_status`
- `stats.files_changed`
- `stats.lines_added`
- `stats.lines_removed`
- `suggested_actions`
- `command` (optional)
- `files[]`

`review.files[]` currently includes:

- `path`
- `action`
- `lines_added`
- `lines_removed`
- `summary`
- `diff_preview`

This is intended to support a mobile or web approval detail screen without requiring the client to reconstruct review context from raw activity events.

### `GET /dashboard/continue-working`

Returns:

- `generated_at`
- `items[]`

Items are one of:

- managed session cards
- recent-work continuation cards

This is the most direct backend contract for a “Continue working” screen in a future UI.

Continue cards are summary-enriched in the background. The daemon returns a heuristic title and summary immediately, then may refresh those fields asynchronously with a model-backed summary using the best available local runtime.

## Activity payload types

Current activity payload variants:

- `command_intent`
- `command_run`
- `file_edit`
- `file_create`
- `file_delete`
- `file_batch_intent`
- `file_batch`
- `test_run`
- `model_call`
- `approval_requested`
- `approval_resolved`
- `error`
- `agent_thinking`
- `session_state_change`

Example `command_run` payload:

```json
{
  "type": "command_run",
  "cmd": "pnpm test",
  "exit_code": 0,
  "duration_ms": 321,
  "stdout_preview": "Tests passed"
}
```

Example `file_batch` payload:

```json
{
  "type": "file_batch",
  "summary": "Updated files: auth.ts, routes.ts",
  "files": [
    {
      "path": "src/auth.ts",
      "action": "edited",
      "lines_added": 4,
      "lines_removed": 2
    },
    {
      "path": "src/routes.ts",
      "action": "created"
    }
  ]
}
```

## SSE contract

### `GET /stream/events`

Global daemon event stream.

### `GET /sessions/:id/events/stream`

Session-scoped event stream.

Events are emitted as SSE with:

- `event: <kind>`
- `data: <json payload>`

SSE is recommended for read-only live views and lightweight dashboards.

## WebSocket contract

### Event sockets

- `GET /ws/events`
- `GET /ws/sessions/:id/events`

Authentication can be supplied either with the usual `Authorization: Bearer <token>` header or, for environments where custom WebSocket headers are awkward, with `?token=<auth_token>` on the socket URL.

These sockets emit JSON messages in the shape:

```json
{
  "event": "activity",
  "data": {
    "kind": "activity",
    "session_id": "session_123",
    "payload": {
      "type": "agent_thinking",
      "summary": "Inspecting the auth middleware."
    }
  }
}
```

Observed `event` values currently include:

- `activity`
- `session`
- `summary`

### Terminal socket

- `GET /ws/sessions/:id/terminal?replay_limit=200`

Server-to-client messages:

- `event: "terminal"` with terminal chunk data
- `event: "control_ack"` with accepted control metadata
- `event: "control_error"` when a control message is rejected

Supported client-to-server messages:

```json
{"type":"send_message","message":"Continue, but avoid touching CI config."}
```

```json
{"type":"stdin","data":"y\n"}
```

```json
{"type":"resize","cols":120,"rows":40}
```

```json
{"type":"stop"}
```

The terminal channel is intentionally operator-focused. It is not yet a full terminal-emulator contract.
