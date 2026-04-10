---
"asynq-agentd": patch
---

Fix broken self-update logic.

- Add `--skip-service-reload` so self-update does not stop the running daemon inside installer before explicit restart.
