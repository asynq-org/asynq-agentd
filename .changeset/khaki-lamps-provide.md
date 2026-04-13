---
"asynq-agentd": patch
---

Fix Codex managed sessions getting stuck at `Reading additional input from stdin...` in pipe mode.

The daemon now closes child stdin after launching non-interactive Codex runs (with an opt-out for explicit live-stdin tests), so new managed sessions start processing immediately instead of waiting indefinitely for stdin EOF.
