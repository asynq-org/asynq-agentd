---
"asynq-agentd-workspace": minor
"asynq-agentd": minor
"asynq-agentctl": minor
---

Add a much richer operator runtime for Buddy and local agent workflows.

- Improve recent-work ingestion for Codex and Claude Code with stable thread titles, observed-vs-managed state, background refresh, imported activity updates, and a dedicated recent-work detail API that serves summaries, raw communication, and changed files from cached data.
- Add model-backed continuation summarization with provider-aware batching, summary caching, debug logging, and better fallback behavior so continue cards and details can stay useful while transcripts evolve.
- Expand the daemon dashboard surface with managed session/review counts, runtime discovery, richer approval review payloads, and cleaner continue-working responses for mobile and dashboard clients.
- Extend `asynq-agentctl` with daemon lifecycle commands, structured log access with follow mode, and persistent summary debug toggles to make local operations and debugging easier.
- Harden local runtime behavior with improved config migration, rotating daemon log files, better simulator/local-network ergonomics, and more reliable event-driven refresh paths for observed work.
