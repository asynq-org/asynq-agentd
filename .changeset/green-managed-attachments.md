---
"asynq-agentd": minor
---

Add screenshot attachments for managed-session prompts and follow-up messages.

Buddy can now send image attachments when creating managed sessions, continuing managed sessions, or taking over observed work. The daemon stores the uploaded screenshots under the local agentd attachment directory and appends compact screenshot context to the prompt so the runtime can use the images without embedding large base64 payloads into the conversation itself.
