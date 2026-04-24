---
"asynq-agentd-workspace": patch
"asynq-agentd": patch
"asynq-agentctl": patch
---

Improve installer UX during longer background steps by printing progress-oriented status messages.

The Unix installer now announces longer waits such as Tailscale hostname detection, auth token creation, daemon API readiness, service reloads, and speech setup. This makes the hosted install flow feel less stalled during 5-15 second background operations and reduces the chance that users interrupt a healthy install because the terminal appears frozen.
