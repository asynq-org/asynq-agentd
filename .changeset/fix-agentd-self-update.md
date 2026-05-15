---
"asynq-agentd": patch
---

Fix Buddy-triggered agentd self-updates by passing the target release ref through the installer environment, surfacing installer output on failure, adding an update command timeout, and skipping speech setup during non-interactive updates.
