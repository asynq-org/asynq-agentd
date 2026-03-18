# Roadmap

`asynq-agentd` is the open-source daemon and local CLI that power the broader Asynq Buddy vision.

This roadmap is intentionally practical: it tracks what should make the daemon useful on its own, not just what sounds ambitious.

## Current phase

Open beta runtime foundation.

What exists today:

- daemon + local CLI
- SQLite persistence
- scheduler, approvals, recurring tasks
- Codex and Claude CLI adapters
- recent-work import
- dashboard-oriented HTTP endpoints
- live SSE/WebSocket streams
- bootstrap installers

## Near-term priorities

### 1. OSS release readiness

- tidy repository structure and docs
- CI, Pages, and release scaffolding
- hosted installer entrypoints
- clearer beta positioning in docs

### 2. Installer and onboarding

- fully reliable one-line install flow
- stronger macOS Tailscale onboarding
- production packaging instead of source-only bootstrap
- clearer post-install operator guidance

### 3. CLI operator experience

- better `status`, `agents`, and `dashboard`
- approval inspection and resolution flows
- more human-friendly summaries over raw JSON

### 4. Runtime stability

- stronger persistence and resume semantics
- safer recovery after restart
- better adapter capability reporting
- retention/history for recurring runs

## Adapter roadmap

### Claude Code

- current: CLI adapter
- next: richer capability detection and deeper integration where feasible

### Codex

- current: CLI adapter with recent-work/activity import
- next: stronger recovery and richer structured activity

### OpenCode

- current: detected by CLI, daemon still uses mock path
- next: real adapter implementation

### Custom adapters

- current: mock path only
- next: documented external adapter contract

## Product-facing backend roadmap

These items are primarily in service of Asynq Buddy:

- presence model for local vs remote use
- notification routing rules
- stronger approval UX payloads
- better “continue working” summaries
- friendlier dashboard aggregates

## Longer-term

- pluggable packaging and service install per platform
- richer approval enforcement before action execution
- more complete terminal/session transport when justified by real UI needs
- stronger multi-project and multi-agent orchestration ergonomics

## Explicit non-goals for now

- pretending the daemon is already a polished hosted product
- building the full Buddy UI in this repo
- over-engineering terminal emulation before the dashboard UX proves the need

## How to use this roadmap

- If you want to contribute, start with the “Near-term priorities”.
- If you are evaluating the project, treat everything here as directional rather than guaranteed by date.
