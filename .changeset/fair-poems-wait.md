---
"asynq-agentd-workspace": patch
"asynq-agentd": patch
"asynq-agentctl": patch
---

Wait for the local daemon API before installer pairing, and retry automatic TLS enablement during pairing bootstrap.

The installer now waits until `asynq-agentctl status` reports the daemon as reachable before opening the Buddy pairing flow, instead of relying on `auth.json` alone. Automatic HTTPS pairing also retries the local `PATCH /config` request for a few seconds before falling back, which reduces startup races that previously left Tailscale installs on plain HTTP and caused Buddy to pair against an unusable IP endpoint.
