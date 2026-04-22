---
"asynq-agentd-workspace": patch
"asynq-agentd": patch
"asynq-agentctl": patch
---

Improve macOS Homebrew Tailscale onboarding reliability for Buddy pairing.

The installer now treats the Homebrew `tailscale` service as system-only on macOS, removes stale per-user LaunchAgents that can leave `tailscaled` crash-looping after reboot, and validates that a detected `.ts.net` MagicDNS hostname is actually usable locally before persisting it as the pairing URL.

Generated installer env and wrapper scripts now also keep `ASYNQ_AGENTD_URL` in sync with `ASYNQ_AGENTD_PUBLIC_URL`, which avoids CLI/daemon endpoint drift after TLS bootstrap.
