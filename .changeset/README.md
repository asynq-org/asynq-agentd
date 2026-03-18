# Changesets

This repository uses Changesets for release versioning.

## When to add a changeset

Add one for any pull request that changes the behavior of:

- the daemon
- the CLI
- installer or onboarding flows
- public API contracts
- release or packaging behavior

You can usually skip a changeset for:

- typo-only doc fixes
- CI-only maintenance
- non-user-visible refactors with no behavioral impact

## Choosing the bump

- `patch`: bug fixes, installer polish, docs that change setup guidance, small CLI improvements
- `minor`: new endpoints, new adapter capabilities, meaningful new daemon or CLI features

The repo is still in `0.x`, so `major` is intentionally avoided for now.

## Typical flow

```bash
pnpm changeset
```

Pick `patch` or `minor`, write a short summary, and commit the generated file in `.changeset/`.
