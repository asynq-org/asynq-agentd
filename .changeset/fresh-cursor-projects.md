---
"asynq-agentd": minor
---

Add a `/projects` API for Buddy project selection and include recent project paths from managed, observed, and scheduled work.

Fix Cursor IDE recent-work indexing on Windows by decoding `file://` workspace URIs with native drive-letter paths, so Cursor takeovers keep the expected project path.
