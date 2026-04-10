---
"asynq-agentd": patch
---

Improve update release notes so Buddy shows structured changelog content.

- Parse `asynq-agentd@...` blocks with `Major/Minor/Patch Changes` from release content.
- Follow linked GitHub PR URLs and extract structured notes from PR descriptions when needed.
- Preserve multiline formatting in release notes for better in-app readability.
- Use a persistent checkout path in the hosted installer so self-update restart does not point wrappers at a deleted temp directory.
- Include `daemon.version` in `asynq-agentctl status` output (or `null` when unreachable).
- Add installer flags for unattended updates (`--reuse-config --non-interactive --skip-pairing`) and make self-update use them by default.
