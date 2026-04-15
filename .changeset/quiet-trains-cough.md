---
"asynq-agentd": minor
---

Improve managed-session parent/child navigation and add observed in-place resolution workflow.

- Add observed approval resolution strategy handling (`auto`, `in_place`, `managed_handoff`) with in-place relay + verification and safe fallback behavior.
- Extend approval resolve request handling for observed approvals with strategy and verification controls.
- Keep managed parent sessions visible in dashboard lists and expose explicit managed parent linkage for continuation chains.
- Improve managed session detail/source metadata so Buddy can open real parent sessions instead of unavailable placeholders.
