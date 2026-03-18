# Contributing

Thanks for your interest in `asynq-agentd`.

This project is still early. The best contributions right now are:

- bug reports with concrete reproduction steps
- adapter/runtime compatibility fixes
- installer improvements across macOS, Linux, and Windows
- docs clarifications for setup, approvals, and recovery behavior
- small, focused backend improvements with tests

## Before opening a PR

1. Read [README.md](./README.md) and [ROADMAP.md](./ROADMAP.md).
2. Check whether the idea fits the current scope of the open-source runtime and CLI.
3. Prefer an issue or short discussion first for larger behavior changes.

## Development

```bash
pnpm install
pnpm test
```

Run the daemon locally:

```bash
node apps/asynq-agentd/src/index.ts
```

In another terminal:

```bash
node apps/asynq-agentctl/src/index.ts agents
node apps/asynq-agentctl/src/index.ts status
```

## Versioning and releases

This repo uses Changesets so version bumps do not have to be edited by hand.

For most behavior-changing PRs, run:

```bash
pnpm changeset
```

Use:

- `patch` for bug fixes, installer polish, docs/setup corrections, and small CLI improvements
- `minor` for new endpoints, new adapter capabilities, and meaningful new daemon or CLI features

Release PRs are opened automatically from `main`, and a Git tag/GitHub Release is created automatically when a new version lands on `main`.

A PR check also reminds you when a behavior-changing change is missing a `.changeset` entry. Docs-only, site-only, and repo-meta-only changes are allowed without one.

## Guidelines

- Keep changes focused. Small PRs are much easier to review.
- Add or update tests for behavior changes.
- Preserve existing naming: the daemon is `asynq-agentd`; the product/UI is `Asynq Buddy`.
- Avoid introducing heavy dependencies unless they materially simplify the runtime.
- Do not silently remove mock paths unless the replacement is complete and tested.
- Document user-facing changes in the README or install docs when relevant.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this project is provided under the Apache-2.0 license that governs this repository.

## Adapters

Adapter contributions are welcome, but please keep them bounded:

- expose a clear start/stop/resume contract
- emit structured events whenever possible
- note any capability gaps in the PR description
- prefer safe fallback behavior over pretending a feature works fully

## Reporting bugs

Please include:

- operating system and version
- Node.js version
- how `asynq-agentd` was started
- which adapter/runtime was involved
- relevant logs or terminal output
- whether the issue happened during install, runtime, recovery, or approval flow

## Project expectations

This repo is intentionally backend-first. A contribution can still be valuable even if it does not touch UI:

- runtime stability
- session recovery
- approvals
- CLI ergonomics
- install and release tooling

Thanks for helping make the daemon reliable.
