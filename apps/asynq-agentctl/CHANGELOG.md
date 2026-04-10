# Changelog

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

All notable changes to the `asynq-agentctl` package will be documented in this file.

For release context that spans the whole workspace, see the root-level [`CHANGELOG.md`](../../CHANGELOG.md).
