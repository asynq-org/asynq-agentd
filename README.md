# asynq-agentd

`asynq-agentd` is the open-source daemon and local CLI behind the broader Asynq Buddy product direction.

## Status

`asynq-agentd` is in early public beta.

The repo is already useful if you want to:

- run a local daemon for Claude Code and Codex
- queue work, approvals, and recurring tasks
- inspect recent work and activity
- use a small operator CLI while the full Buddy UI is still being built separately

What is still intentionally beta:

- installer polish and hosted one-line install
- OpenCode adapter implementation
- deeper recovery semantics
- stronger release packaging and release automation

## What is implemented

- Native TypeScript runtime using Node.js only
- SQLite-backed persistence via `node:sqlite`
- In-process scheduler with task dependencies and bounded parallelism
- Session, task, approval, activity, config, and stats REST endpoints
- Dashboard-oriented REST endpoints for overview, attention-required, and continue-working cards
- Background summary enrichment for dashboard cards with provider auto-selection (`claude` -> `codex` -> heuristic)
- Pluggable adapter layer with real Codex and Claude Code CLI adapters plus mock fallbacks
- Bearer-token auth with local token persistence in `.asynq-agentd/auth.json`
- Project-level `.asynq-agentd.yaml` inheritance for task context
- Project-level approval/model routing overrides via `.asynq-agentd.yaml`
- Recurring tasks via cron expressions
- Codex task execution via `codex exec --json` with live activity import
- Claude Code task execution via `claude -p --output-format stream-json`
- Basic recovery for Codex-backed running tasks after daemon restart
- Basic recovery for Claude/Codex-backed running tasks after daemon restart
- PID-aware runtime reconciliation to avoid duplicating already-running CLI sessions after restart
- Resume-confidence recovery that pauses interrupted CLI tasks when no safe external session id is available
- First runtime approval interception hooks for dangerous commands, deletions, and model spend
- Early intent-based approval interception for Codex and Claude tool calls before command output arrives
- Recent-work indexing and continuation from `~/.claude/` and `~/.codex/`
- Codex recent-work summaries derived from session transcripts
- Continuation tasks enriched with transcript-derived recent context
- `/activity` can now surface imported Codex session events via recent-work
- Imported Codex `/activity` includes tool and command executions from real session logs
- Imported Codex `/activity` also derives file edits from `apply_patch` side effects
- Imported Codex `/activity` can infer `test_run` summaries from recognizable test command output
- Imported Codex `/activity` is lightly condensed to reduce noisy duplicate and per-file event spam
- Imported Codex `/activity` supports `compact=false` for callers that need the raw, uncondensed feed
- `/recent-work` can optionally include a small imported activity preview for each item
- `/recent-work` preview can be filtered by event type with `preview_types=...`
- SSE live streams for all events or a single session via `/stream/events` and `/sessions/:id/events/stream`
- WebSocket live streams for global events, session events, and raw terminal chunks
- WebSocket terminal control messages for operator follow-up and stop requests
- Live terminal stdin relay for running Claude and Codex CLI sessions
- Bounded terminal scrollback with snapshot and replay for late-joining clients
- Opportunistic macOS PTY transport via `/usr/bin/script` when the daemon itself has a TTY
- Persistent terminal scrollback in SQLite and resize control metadata for session attach
- Background watcher for `~/.claude/` and `~/.codex/` changes
- Minimal `asynq-agentctl` CLI for local control
## Community

- Changelog: [CHANGELOG.md](./CHANGELOG.md)
- Contributing guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security notes: [SECURITY.md](./SECURITY.md)
- Roadmap: [ROADMAP.md](./ROADMAP.md)
- Usage examples: [docs/usage.md](./docs/usage.md)
- API contract: [docs/api.md](./docs/api.md)

## Run

Bootstrap install from a local checkout:

```bash
sh ./scripts/install.sh
```

Windows bootstrap install from a local checkout:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Hosted bootstrap entrypoints for GitHub Pages or a custom domain:

```bash
curl -fsSL https://agentd.asynq.org/install.sh | sh
```

```powershell
irm https://agentd.asynq.org/install.ps1 | iex
```

More detail is in [docs/install.md](./docs/install.md).

The bootstrap installer is interactive: it can set runtime home, choose an access mode (`local`, `tailscale`, `custom`), guide first-class Tailscale onboarding with a CLI-first macOS flow, write a reusable env file with bind/public URL defaults, install a per-user service, capture the public daemon URL for mobile pairing, and print a pairing QR as soon as the daemon has generated `auth.json`.

The hosted `install.sh` and `install.ps1` entrypoints are intentionally thin wrappers today: they clone the repository into a temporary directory and then run the real bootstrap installer from that checkout.

## Release flow

`asynq-agentd` uses Changesets for versioning.

- Most behavior-changing PRs should include a `.changeset/*.md` file.
- `patch` is the default for fixes and polish.
- `minor` is for meaningful new daemon, CLI, adapter, or API capabilities.
- GitHub Actions opens a release PR automatically from `main`.
- When that version PR lands, GitHub Actions creates the matching tag and GitHub Release automatically.
- Pull requests that change runtime, CLI, installer, API, or release behavior are expected to include a `.changeset` entry; docs-only and site-only changes can skip it.

```bash
pnpm install
pnpm test
node apps/asynq-agentd/src/index.ts
```

In another terminal:

```bash
node apps/asynq-agentctl/src/index.ts agents
node apps/asynq-agentctl/src/index.ts status
node apps/asynq-agentctl/src/index.ts dashboard
node apps/asynq-agentctl/src/index.ts approvals
node apps/asynq-agentctl/src/index.ts recent-work --preview --preview-limit 3
node apps/asynq-agentctl/src/index.ts token --shell
node apps/asynq-agentctl/src/index.ts restart
node apps/asynq-agentctl/src/index.ts tls status
node apps/asynq-agentctl/src/index.ts tls enable --cert /path/to/cert.pem --key /path/to/key.pem
node apps/asynq-agentctl/src/index.ts submit "Refactor auth module" --project /tmp/demo --description "Start with the daemon skeleton"
node apps/asynq-agentctl/src/index.ts submit "Nightly regression run" --project /tmp/demo --schedule "0 2 * * *" --approval-required
```

By default the daemon stores state in `.asynq-agentd/` inside this workspace and listens on `http://127.0.0.1:7433`.

Authenticated routes use the token from `.asynq-agentd/auth.json`. The CLI reads it automatically when run from the repo root.

If you want to use the token in your own shell tooling, run `asynq-agentctl token` or `asynq-agentctl token --shell`.

For Buddy mobile pairing, run `node apps/asynq-agentctl/src/index.ts pairing` after the daemon has started once and created `auth.json`. In an interactive terminal the CLI now prints a QR code by default, and the installer guides that flow automatically when possible.

For production iPhone pairing, prefer an `https://...` public daemon URL. The daemon can now bind HTTPS directly when TLS is enabled in config (for example via `asynq-agentctl tls enable --cert ... --key ...` followed by a restart), and Buddy will automatically upgrade its live transport from `ws://` to `wss://`.

Codex-backed tasks currently expect a working `codex` CLI on `PATH` (or `ASYNQ_AGENTD_CODEX_BIN` pointing to it). Claude-backed tasks expect a working `claude` CLI on `PATH` or at `~/.local/bin/claude` (or `ASYNQ_AGENTD_CLAUDE_BIN` pointing to it), plus an authenticated Claude Code session.

If a project contains `.asynq-agentd.yaml`, the daemon will merge config such as `project.test_command` and `project.context_files` into newly created tasks for that project.

`GET /recent-work` scans the local Claude and Codex homes, stores indexed items, and `POST /recent-work/:id/continue` creates a continuation task when a project path can be inferred. Callers can request lightweight previews with `GET /recent-work?include_activity_preview=true&activity_preview_limit=3`, may combine that with `compact=false` if they want raw imported preview events, and can narrow the preview payload with `preview_types=file_batch,agent_thinking`. `GET /activity?recent_work=<id>` maps observed Codex session logs into the same structured activity shape used by daemon-managed sessions, including state changes, transcript summaries, model usage, command/tool executions, file changes derived from `apply_patch`, and test summaries inferred from recognizable test output. Imported feeds are lightly condensed by default, for example by collapsing duplicate model/state events and grouping multi-file patch changes into a single `file_batch` record; callers can request the raw variant with `GET /activity?recent_work=<id>&compact=false`. For live UI updates, SSE streams are available at `GET /stream/events` and `GET /sessions/:id/events/stream`, and WebSocket streams are available at `GET /ws/events`, `GET /ws/sessions/:id/events`, and `GET /ws/sessions/:id/terminal`. The terminal WebSocket now accepts `{"type":"send_message","message":"..."}`, `{"type":"stdin","data":"..."}`, `{"type":"resize","cols":120,"rows":40}` and `{"type":"stop"}` so UI clients can issue operator follow-ups, stream raw stdin to the underlying CLI process, update attached terminal geometry, or stop a session without falling back to REST. Terminal scrollback is now persisted in SQLite, available over `GET /sessions/:id/terminal?limit=200`, and replayed automatically when a new terminal WebSocket subscriber connects, including after daemon restart. On macOS foreground runs where the daemon itself has a TTY, the adapter layer can now opportunistically wrap Claude/Codex through `/usr/bin/script` to get a PTY-backed transport; service/non-TTY environments safely fall back to direct pipes. Runtime approval policy hooks now also pause sessions after policy-matched dangerous commands, file deletions, or threshold-breaking model spend, creating an approval request before the daemon allows further progress. For Codex-backed sessions, the daemon watches `function_call` and `custom_tool_call` intent events so policy can stop dangerous work before the corresponding tool output arrives. For Claude-backed sessions, it now does the same for `assistant.message.content[].tool_use`, including real `Bash` and `Edit` tool intents observed in local Claude transcript data. Restart recovery now also distinguishes between safe resume and risky relaunch: if a dead Claude/Codex process still has a resumable external session id, the daemon resumes it; if not, the task is paused and an approval request is created before any fresh relaunch can happen.

For dashboard-style Buddy clients, the daemon now also exposes `GET /dashboard/overview`, `GET /dashboard/attention-required`, and `GET /dashboard/continue-working`, so the UI can render high-level cards without stitching together raw session/task/approval endpoints client-side. `GET /dashboard/overview` now also includes daemon-detected runtime readiness, and the dashboard card text is summary-enriched in the background: the daemon serves a heuristic title/summary immediately, then may replace it with a cached model-backed summary using the best available local runtime. Global and session-scoped WebSocket event streams now emit `summary` events alongside `activity` and `session`, which lets Buddy-style clients refresh cards without manual reload.

Copyright (c) 2026 Asynq.org. Licensed under Apache-2.0.
