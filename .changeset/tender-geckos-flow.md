---
"asynq-agentd-workspace": patch
"asynq-agentd": patch
"asynq-agentctl": patch
---

Wait for the local daemon API before running installer pairing and TLS bootstrap.

The Unix installer no longer treats the presence of `auth.json` as enough to start Buddy pairing. It now waits until `asynq-agentctl status` reports the daemon as reachable, which avoids early `fetch failed` errors during automatic HTTPS enablement and reduces cases where the installer leaves the public pairing URL on plain HTTP even though TLS cert material is already available.
