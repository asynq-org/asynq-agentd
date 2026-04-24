---
"asynq-agentd-workspace": patch
"asynq-agentd": patch
"asynq-agentctl": patch
---

Recover local CLI connectivity after daemon TLS is enabled, and persist the upgraded local control URL.

When Buddy pairing or `tls enable` switches the daemon to HTTPS, `asynq-agentctl` now upgrades the local loopback control URL from `http://127.0.0.1` to `https://127.0.0.1`, retries the request over local TLS, and persists the new `ASYNQ_AGENTD_URL` in the runtime env file. This fixes reinstall and upgrade flows where the daemon was already serving HTTPS but the CLI still attempted plain HTTP and reported `fetch failed`.
