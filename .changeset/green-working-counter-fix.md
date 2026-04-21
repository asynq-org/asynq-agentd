---
"asynq-agentd": patch
---

Fix stale observed sessions reporting as currently working after a crash or forced process kill.

`agentd` now reports observed `is_working` from recent-work freshness instead of treating every `status: "active"` record as still running. This keeps Buddy's `Working` counter aligned with real live work after OOMs, restarts, or abruptly terminated desktop agent processes.
