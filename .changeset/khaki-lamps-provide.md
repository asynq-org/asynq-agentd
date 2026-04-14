---
"asynq-agentd": patch
---

Add markdown export support for managed/continue outputs:

- `POST /exports/markdown` saves output to `<project>/.asynq-exports/*.md` and returns the saved path.
- `POST /exports/open` opens/reveals a saved export file on the host Mac.
- Export automatically adds `.asynq-exports/` to the project's `.gitignore` when `.gitignore` exists and the entry is missing.
