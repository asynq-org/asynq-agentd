---
"asynq-agentd": minor
---

Add Claude Code observed-review continuation support.

Claude Code observed approvals can now use the same headless same-thread continuation flow as Codex when Buddy cannot click the original desktop prompt directly. The daemon sends the operator decision through `claude -p --resume`, tracks the final Claude response, and stores follow-up `NEXT_APPROVAL_REQUIRED` requests so multi-step Claude work can be approved from Buddy one step at a time.

Recurring tasks now keep a compact per-task run history in task context. Each scheduled run records a short status summary, recent changed work, and whether it completed or failed; future runs receive this compact history in their prompt so recurring agents can avoid duplicating previous output.
