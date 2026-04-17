---
"asynq-agentd": minor
"asynq-agentctl": minor
---

Add local voice-prompt transcription support for Buddy.

Buddy can now record dictated prompts and send them to `agentd` for local transcription before the user submits the final message. The daemon accepts recorded audio uploads on a new transcription endpoint, stores the audio locally, converts it to a Whisper-compatible format with `ffmpeg`, and returns the transcribed text so Buddy can prefill the prompt composer for review and editing.

`asynq-agentctl` now includes `speech status` and `speech setup` commands so existing installs can configure local Whisper transcription later without rerunning the whole installer. The installer also best-effort calls this setup flow automatically unless explicitly skipped.
