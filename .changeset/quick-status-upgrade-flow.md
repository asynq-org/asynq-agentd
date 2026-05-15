---
"asynq-agentd": patch
"asynq-agentctl": patch
---

Make `asynq-agentctl status` a fast daemon health check by using a new lightweight `/status` endpoint with daemon version, runtime availability, and aggregate counts instead of loading full sessions.

Start agentd self-updates asynchronously from `/updates/install` so Buddy gets an immediate `installing` response while install and restart continue in the background.
