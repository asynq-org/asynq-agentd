---
"asynq-agentd": patch
---

Improve update release notes so Buddy shows structured changelog content.

- Parse `asynq-agentd@...` blocks with `Major/Minor/Patch Changes` from release content.
- Follow linked GitHub PR URLs and extract structured notes from PR descriptions when needed.
- Preserve multiline formatting in release notes for better in-app readability.
