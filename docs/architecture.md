# Architecture

> [agentd.asynq.org](https://agentd.asynq.org) · [API](./api.md) · [Usage](./usage.md) · [Buddy](https://buddy.asynq.org) · Apache 2.0

`asynq-agentd` is a small, dependency-light local runtime for coding agents. It is intentionally split into a long-running daemon and a thin operator CLI, with a clean HTTP / SSE / WebSocket contract between them so any UI (the bundled CLI, [Asynq Buddy](https://buddy.asynq.org), or your own dashboard) can sit on top.

This document explains how the pieces fit together.

## Goals

- **Local-first.** Code, prompts, and session output never leave the machine.
- **Dependency-light core.** The daemon should be runnable from a fresh checkout with minimal package installation.
- **Stable contract.** External tools talk to a single HTTP / SSE / WebSocket surface, not to internal modules.
- **Adapter isolation.** Each agent runtime (Claude Code, Codex, future ones) is plugged in behind a uniform interface, so the scheduler, storage, and API never need to know which agent is running.
- **Operator-friendly.** The CLI and the contract are designed to make sessions, approvals, and recent work observable from the outside.

## High-level diagram

```
                ┌───────────────────────────────────┐
                │            Operators              │
                │   asynq-agentctl · Buddy · curl   │
                └────────────────┬──────────────────┘
                                 │
                       HTTP / SSE / WebSocket
                                 │
        ┌────────────────────────▼───────────────────────┐
        │                 asynq-agentd                   │
        │  ┌─────────────┐  ┌──────────────┐  ┌────────┐ │
        │  │  HTTP API   │  │   Scheduler  │  │ Events │ │
        │  └─────┬───────┘  └──────┬───────┘  └────┬───┘ │
        │        │                 │               │     │
        │  ┌─────▼─────────────────▼───────────────▼───┐ │
        │  │              Adapter layer                │ │
        │  │   Claude Code · Codex · (future agents)   │ │
        │  └─────┬─────────────────────────────────┬───┘ │
        │        │                                 │     │
        │  ┌─────▼──────┐                  ┌───────▼───┐ │
        │  │  Storage   │                  │  Config   │ │
        │  │  (SQLite)  │                  │  (file)   │ │
        │  └────────────┘                  └───────────┘ │
        └────────────────────────────────────────────────┘
                                 │
                                 ▼
                       Agent processes / tmux
```

## Components

### `apps/asynq-agentd` — the daemon

The daemon is the long-running process. It owns:

- The HTTP API server (REST endpoints for sessions, tasks, approvals, activity, config, stats, recent work, and dashboard cards).
- The SSE and WebSocket transports for live event streaming.
- The scheduler that drives task execution and dependency resolution.
- The storage layer (SQLite via Node's built-in `node:sqlite` module).
- The adapter layer that talks to real agent runtimes.
- The pairing flow used by Buddy and other operators over the local tailnet.

The daemon is designed to be runnable straight from a checkout: no native bindings, no extra build step for storage. Configuration lives in a single file, and the on-disk state is one SQLite database plus a small set of working directories per session.

### `apps/asynq-agentctl` — the operator CLI

`asynq-agentctl` is a thin client. It does not contain any business logic, scheduling, or storage of its own. Every command translates to one or more HTTP calls against the daemon and pretty-prints the response.

This separation matters: anything the CLI can do, an external tool (or Buddy) can do too, because they share the same contract. The CLI is essentially a reference implementation of that contract.

### Adapter layer

The adapter interface isolates agent runtimes from the rest of the daemon. Each adapter is responsible for:

- Spawning and supervising the underlying agent process (Claude Code, Codex CLI, etc.).
- Translating daemon-level concepts (start a task, send input, request an approval, stop a session) into the agent's own protocol.
- Streaming output and lifecycle events back to the daemon as structured events.
- Reporting health and availability so the daemon can mark agents as up, degraded, or unavailable.

Mock adapters exist alongside the real ones so the scheduler, storage, and API can be exercised end-to-end even when a real agent runtime is not installed.

### Storage

Persistence uses SQLite via `node:sqlite`. There is no ORM. The schema is intentionally narrow and centered on the things operators need to observe:

- **Sessions** — one row per agent session, with state, working directory, and adapter id.
- **Tasks** — units of work scheduled inside a session, with status and dependency edges.
- **Approvals** — pending decisions surfaced to operators (modify files, run command, etc.).
- **Events** — append-only event log used to feed SSE / WebSocket subscribers and to reconstruct activity.
- **Config** — daemon-wide settings, pairing material, and adapter configuration.

Because every durable piece of state lives in SQLite, restarting the daemon is safe: in-flight sessions are reattached to their adapters and event streams resume from the last known position.

### Live transports

Two real-time channels sit on top of the same event log:

- **Server-Sent Events (`/events`)** for read-only subscribers (CLI tail, dashboards).
- **WebSocket (`/ws`)** for bidirectional clients that also need to push input or approvals.

Both share the same event schema, so a client can pick whichever transport fits its environment.

## Data flow

A typical task lifecycle looks like this:

1. An operator creates or resumes a session via the HTTP API.
2. The scheduler selects the appropriate adapter and asks it to start the agent process.
3. The adapter streams output events back into the daemon, which appends them to the event log and writes durable state into SQLite.
4. When the agent needs human input (approve a file change, confirm a command), the adapter raises an approval. The daemon stores it and broadcasts an `approval.created` event.
5. An operator (CLI, Buddy, custom UI) reacts to the event and posts a decision back through the HTTP API.
6. The daemon forwards the decision to the adapter, which unblocks the agent.

Every step is observable through the same contract — there is no privileged side channel.

## Configuration

The daemon reads a single configuration file at startup. It controls:

- Bind address and port for the HTTP API.
- Auth token for non-public routes.
- Pairing settings (Tailscale-aware, no hosted relay).
- Adapter-specific options (paths, models, environment).
- Storage and working-directory locations.

The CLI reads the same config file (or a small subset of it) so commands like `asynq-agentctl status` can talk to the daemon without extra flags.

## Why this shape

The split between **daemon**, **adapters**, **storage**, and **contract** is what makes the project useful beyond a single UI:

- The CLI is a debugging surface, not the only way in.
- Buddy is a polished mobile operator built on top of the same contract.
- Custom dashboards and integrations can be written against the documented HTTP / SSE / WebSocket endpoints without forking the daemon.

The runtime is intentionally conservative right now: packaging, deeper pre-action approval control, and richer terminal/session transport are all deliberately incremental. The goal is to keep the contract stable while the implementation underneath grows.

## See also

- [API contract](./api.md) — HTTP, SSE, and WebSocket reference.
- [Usage examples](./usage.md) — practical CLI workflows.
