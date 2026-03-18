# Changelog

All notable changes to `asynq-agentd` will be documented in this file.

The format is inspired by Keep a Changelog and the project follows SemVer-style `0.x` releases while the runtime is still in early beta.

## [0.1.0] - 2026-03-17

### Added

- Open-source `asynq-agentd` daemon workspace with `asynq-agentd` and `asynq-agentctl`.
- SQLite-backed persistence for sessions, tasks, approvals, activity, config, and terminal scrollback.
- Scheduler support for priorities, dependencies, approvals, recurring tasks, restart recovery, and PID-aware reconciliation.
- Real Claude Code and Codex CLI adapters, plus mock fallback paths where a real adapter is not ready yet.
- Recent-work indexing for `~/.claude/` and `~/.codex/`, including continuation task creation and transcript-derived Codex summaries.
- Dashboard-oriented endpoints for overview, attention-required, and continue-working cards.
- SSE and WebSocket event streams, plus a lightweight terminal relay/control surface.
- Installer scaffolding for macOS, Linux, and Windows with Tailscale-aware onboarding.
- GitHub Pages landing scaffold, CI workflows, roadmap, contribution guide, security policy, code of conduct, and issue templates.

### Changed

- Moved repository licensing to Apache-2.0 with a `NOTICE` file and clearer contribution terms.
- Improved CLI ergonomics with `agents`, `status`, `dashboard`, and default QR output for pairing.
- Cleaned public docs to remove internal handoff notes and private workspace references before first public release.

### Known beta edges

- Hosted install remains a bootstrap flow that clones or runs from source rather than using packaged binaries.
- OpenCode is detected in the CLI but does not yet have a real daemon adapter.
- Approval interception is stronger than before, but still not a full universal pre-action gate.
- Terminal relay is intentionally operator-focused rather than a full terminal emulator.
