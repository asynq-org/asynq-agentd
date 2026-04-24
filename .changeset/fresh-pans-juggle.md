---
"asynq-agentd-workspace": patch
"asynq-agentd": patch
"asynq-agentctl": patch
---

Allow local CLI control over HTTPS loopback even when the daemon certificate is issued for the Tailscale hostname.

When `ASYNQ_AGENTD_URL` already points to `https://127.0.0.1` or `https://localhost`, `asynq-agentctl` now treats that as a local control-plane exception and disables hostname verification for the loopback TLS request. This fixes reinstall and update flows where the daemon is already serving HTTPS with a cert for `*.ts.net`, but the local CLI must still manage it over loopback before the public Buddy URL is updated.
