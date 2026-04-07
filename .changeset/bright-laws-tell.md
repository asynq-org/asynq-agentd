---
"asynq-agentd": patch
---

Improve observed and managed Codex session handling across recent work, reviews, and takeovers.

- keep observed recent-work cards stable when managed follow-ups complete, including better filtering of stale managed continuations and internal relay artifacts
- refresh recent work from disk before serving dashboard detail so newer Codex transcript content shows up reliably
- detect observed Codex approval requests and surface them in attention-required views, with takeover support classified as Buddy-managed or desktop-only
- relay managed handoff summaries back into observed Codex threads without reusing the managed execution session itself
- tighten observed takeovers by carrying structured command context and success checks, and avoid marking managed takeovers complete when verification fails
- improve Codex managed continuation resume behavior by persisting thread ids from `thread.started` events and strengthening fallback continuation context
- allow deleting standalone managed session chains from Buddy, including continuation trees rooted at the visible managed session
