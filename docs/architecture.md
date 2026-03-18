# Architecture

`asynq-agentd` favors a dependency-light core that can run from source with minimal setup:

- `apps/asynq-agentd` contains the daemon, scheduler, storage, adapters, and HTTP API.
- `apps/asynq-agentctl` contains a thin CLI that talks to the daemon over HTTP.
- SQLite persistence uses Node's built-in `node:sqlite` module so the daemon is runnable without package installation.
- The adapter interface isolates the future Claude SDK and tmux integrations from the scheduler and storage layers.

The current runtime is intentionally conservative:

- It persists durable records for sessions, tasks, approvals, events, and config.
- It can execute tasks through real Claude Code and Codex CLI adapters, while still keeping mock fallbacks where a real runtime is not ready yet.
- It keeps packaging, deeper pre-action approval control, and richer terminal/session transport intentionally incremental.
