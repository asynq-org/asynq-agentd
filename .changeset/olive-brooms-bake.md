---
"asynq-agentd-workspace": patch
"asynq-agentd": patch
"asynq-agentctl": patch
---

Separate the local daemon URL from the public Buddy pairing URL during install.

The installer now keeps `ASYNQ_AGENTD_URL` pointed at local loopback for CLI and bootstrap operations, while `ASYNQ_AGENTD_PUBLIC_URL` remains the externally reachable address used for Buddy pairing. This avoids local control-plane failures when the machine cannot resolve its own MagicDNS hostname.

The Unix installer messaging was also clarified for Tailscale onboarding, including how to find the current tailnet hostname and where to open Buddy after install.
