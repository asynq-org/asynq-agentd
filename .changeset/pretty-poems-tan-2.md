---
"asynq-agentd": patch
---

Fix broken self-update logic.

- Detect daemon version from `apps/asynq-agentd/package.json` instead of a stale hardcoded value.
- Pin self-update installs to the detected latest release tag (`ASYNQ_AGENTD_REF=vX.Y.Z`) and fall back to `asynq-agentctl start` if restart is unavailable.
