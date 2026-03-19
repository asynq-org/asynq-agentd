# Usage examples

This page shows practical ways to use `asynq-agentd` today from the CLI, HTTP API, and live transport layers.

## Start the daemon

From a local checkout:

```bash
pnpm install
pnpm test
node apps/asynq-agentd/src/index.ts
```

If you used the installer, you can instead run:

```bash
asynq-agentd
```

## Check daemon status

```bash
asynq-agentctl status
```

Useful CLI commands:

```bash
asynq-agentctl agents
asynq-agentctl sessions
asynq-agentctl dashboard
asynq-agentctl tasks
asynq-agentctl approvals
asynq-agentctl approve <approval_id>
asynq-agentctl reject <approval_id> --note "Needs a safer plan"
asynq-agentctl recent-work --preview --preview-limit 3
asynq-agentctl continue <recent_work_id> --instruction "Continue, but do not change tests yet."
asynq-agentctl activity
asynq-agentctl config
asynq-agentctl token --shell
asynq-agentctl pairing
```

## Submit a task

Simple task:

```bash
asynq-agentctl submit "Refactor auth middleware" \
  --project /path/to/repo \
  --description "Start with the auth middleware and keep tests green."
```

Task that requires approval before execution:

```bash
asynq-agentctl submit "Run migration review" \
  --project /path/to/repo \
  --description "Inspect the migration plan before changing files." \
  --approval-required
```

Recurring task:

```bash
asynq-agentctl submit "Nightly regression run" \
  --project /path/to/repo \
  --description "Run the regression suite and report failures." \
  --schedule "0 2 * * *"
```

## Continue recent work

List indexed recent work:

```bash
asynq-agentctl recent-work
```

List recent work with activity preview:

```bash
asynq-agentctl recent-work --preview --preview-limit 3
```

Continue a recent-work item:

```bash
asynq-agentctl continue <recent_work_id> \
  --instruction "Continue, but do not change tests yet."
```

Equivalent HTTP request:

```bash
curl -H "Authorization: Bearer $ASYNQ_AGENTD_TOKEN" \
  "http://127.0.0.1:7433/recent-work?include_activity_preview=true&activity_preview_limit=3"
```

```bash
curl -X POST \
  -H "Authorization: Bearer $ASYNQ_AGENTD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"instruction":"Continue, but do not change tests yet."}' \
  "http://127.0.0.1:7433/recent-work/<recent_work_id>/continue"
```

## Review approvals

List pending approvals:

```bash
asynq-agentctl approvals
```

Approve one:

```bash
asynq-agentctl approve <approval_id> --note "Looks good."
```

Reject one:

```bash
asynq-agentctl reject <approval_id> --note "Please avoid changing the migration files."
```

## Inspect dashboard-oriented data

Overview card payload:

```bash
curl -H "Authorization: Bearer $ASYNQ_AGENTD_TOKEN" \
  http://127.0.0.1:7433/dashboard/overview
```

Attention-required cards:

```bash
curl -H "Authorization: Bearer $ASYNQ_AGENTD_TOKEN" \
  http://127.0.0.1:7433/dashboard/attention-required
```

Continue-working cards:

```bash
curl -H "Authorization: Bearer $ASYNQ_AGENTD_TOKEN" \
  http://127.0.0.1:7433/dashboard/continue-working
```

These endpoints are the clearest starting point for a future UI. They intentionally return UI-friendly summaries instead of forcing a client to stitch together sessions, tasks, approvals, and recent-work on its own.

## Watch activity with SSE

All live events:

```bash
curl -N \
  -H "Authorization: Bearer $ASYNQ_AGENTD_TOKEN" \
  http://127.0.0.1:7433/stream/events
```

One session only:

```bash
curl -N \
  -H "Authorization: Bearer $ASYNQ_AGENTD_TOKEN" \
  http://127.0.0.1:7433/sessions/<session_id>/events/stream
```

SSE is useful for dashboards and read-only live views.

## Watch and control a session with WebSocket

Session events:

```text
GET /ws/sessions/:id/events
Authorization: Bearer <token>
```

Terminal-style stream:

```text
GET /ws/sessions/:id/terminal?replay_limit=200
Authorization: Bearer <token>
```

Example control messages sent over the terminal WebSocket:

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

Terminal WebSocket is meant to be an operator surface, not a full terminal emulator.

## Pair a future Buddy client

Generate pairing info:

```bash
asynq-agentctl pairing
```

JSON output for your own tooling:

```bash
asynq-agentctl pairing --format json
```

The pairing payload includes:

- daemon endpoint
- auth token
- `asynqbuddy://` pairing URI
- web fallback URL at `buddy.asynq.org`

## Use the auth token in a terminal

Print the token directly:

```bash
asynq-agentctl token
```

Print a shell export:

```bash
asynq-agentctl token --shell
```

Example:

```bash
eval "$(asynq-agentctl token --shell)"
curl -H "Authorization: Bearer $ASYNQ_AGENTD_TOKEN" http://127.0.0.1:7433/tasks
```

## Use project defaults

If a repo contains `.asynq-agentd.yaml`, new tasks for that project can inherit defaults such as:

- `project.test_command`
- `project.context_files`
- `project.default_model_preference`
- `project.default_approval_required`

Example:

```yaml
project:
  test_command: pnpm test
  context_files:
    - CLAUDE.md
    - docs/architecture.md
  default_model_preference: claude-opus
  default_approval_required: true
```

## Typical integration layers

`asynq-agentd` can be used in three increasingly rich ways:

1. CLI-only operator workflow via `asynq-agentctl`
2. Thin dashboard client using the dashboard endpoints plus SSE
3. Richer operator UI using dashboard endpoints, `/activity`, `/recent-work`, and terminal/session WebSockets
