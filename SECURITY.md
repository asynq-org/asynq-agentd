# Security Policy

If you believe you found a security issue in `asynq-agentd`, please do not open a public issue with exploit details.

Until a dedicated security contact exists, use a private channel controlled by the project maintainer and include:

- affected version or commit
- operating system
- impact summary
- reproduction steps
- whether the issue involves auth, approvals, adapters, installer flow, or exposed network access

## Scope

Security-sensitive areas in this project include:

- bearer-token auth and pairing payloads
- approval interception and policy handling
- local daemon exposure over HTTP/WebSocket
- installer behavior and service configuration
- adapter interaction with local CLIs and file system access

## Response expectations

This project is still early-stage, so response times may vary. Valid reports will be investigated and fixed as quickly as possible.
