---
"asynq-agentd-workspace": patch
"asynq-agentd": patch
"asynq-agentctl": patch
---

Fix hosted installer prompting for `curl | sh` onboarding.

The Unix installer now reads interactive prompts from `/dev/tty` when stdin is a pipe, so hosted installs can wait for the operator instead of silently accepting placeholder defaults. In non-interactive Tailscale mode, onboarding now fails fast if no usable MagicDNS hostname is available instead of continuing with `your-machine.tailnet.ts.net`.
