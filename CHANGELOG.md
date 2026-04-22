# Changelog

## 0.8.2

### Patch Changes

- Improve macOS Homebrew Tailscale onboarding reliability for Buddy pairing.

  The installer now treats the Homebrew `tailscale` service as system-only on macOS, removes stale per-user LaunchAgents that can leave `tailscaled` crash-looping after reboot, and validates that a detected `.ts.net` MagicDNS hostname is actually usable locally before persisting it as the pairing URL.

  Generated installer env and wrapper scripts now also keep `ASYNQ_AGENTD_URL` in sync with `ASYNQ_AGENTD_PUBLIC_URL`, which avoids CLI/daemon endpoint drift after TLS bootstrap.

## 0.8.1

## 0.8.0

## 0.7.0

## 0.6.0

## 0.5.2

## 0.5.1

## 0.5.0

## 0.4.6

## 0.4.5

## 0.4.4

## 0.4.3

## 0.4.2

## 0.4.1

## 0.4.0

### Minor Changes

- Add a much richer operator runtime for Buddy and local agent workflows. - Improve recent-work ingestion for Codex and Claude Code with stable thread titles, observed-vs-managed state, background refresh, imported activity updates, and a dedicated recent-work detail API that serves summaries, raw communication, and changed files from cached data. - Add model-backed continuation summarization with provider-aware batching, summary caching, debug logging, and better fallback behavior so continue cards and details can stay useful while transcripts evolve. - Expand the daemon dashboard surface with managed session/review counts, runtime discovery, richer approval review payloads, and cleaner continue-working responses for mobile and dashboard clients. - Extend `asynq-agentctl` with daemon lifecycle commands, structured log access with follow mode, and persistent summary debug toggles to make local operations and debugging easier. - Harden local runtime behavior with improved config migration, rotating daemon log files, better simulator/local-network ergonomics, and more reliable event-driven refresh paths for observed work.

## 0.3.0

### Minor Changes

- Improve the public operator surface with usage and API contract docs, richer `asynq-agentctl` commands for approvals, recent work, and auth token handling, plus better cross-platform path handling, workflow reliability, and a clearer landing page for `agentd.asynq.org`.

All notable changes to `asynq-agentd` will be documented in this file.

The format is inspired by Keep a Changelog and the project follows SemVer-style `0.x` releases while the runtime is still in early beta.

Release entries below `0.1.0` are currently maintained by Changesets during the automated release flow.

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
