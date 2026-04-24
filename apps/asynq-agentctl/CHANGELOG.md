# Changelog

## 0.8.4

### Patch Changes

- Separate the local daemon URL from the public Buddy pairing URL during install.

  The installer now keeps `ASYNQ_AGENTD_URL` pointed at local loopback for CLI and bootstrap operations, while `ASYNQ_AGENTD_PUBLIC_URL` remains the externally reachable address used for Buddy pairing. This avoids local control-plane failures when the machine cannot resolve its own MagicDNS hostname.

  The Unix installer messaging was also clarified for Tailscale onboarding, including how to find the current tailnet hostname and where to open Buddy after install.

## 0.8.3

### Patch Changes

- Fix hosted installer prompting for `curl | sh` onboarding.

  The Unix installer now reads interactive prompts from `/dev/tty` when stdin is a pipe, so hosted installs can wait for the operator instead of silently accepting placeholder defaults. In non-interactive Tailscale mode, onboarding now fails fast if no usable MagicDNS hostname is available instead of continuing with `your-machine.tailnet.ts.net`.

## 0.8.2

### Patch Changes

- Improve macOS Homebrew Tailscale onboarding reliability for Buddy pairing.

  The installer now treats the Homebrew `tailscale` service as system-only on macOS, removes stale per-user LaunchAgents that can leave `tailscaled` crash-looping after reboot, and validates that a detected `.ts.net` MagicDNS hostname is actually usable locally before persisting it as the pairing URL.

  Generated installer env and wrapper scripts now also keep `ASYNQ_AGENTD_URL` in sync with `ASYNQ_AGENTD_PUBLIC_URL`, which avoids CLI/daemon endpoint drift after TLS bootstrap.

## 0.8.1

## 0.8.0

### Minor Changes

- Add local voice-prompt transcription support for Buddy.

  Buddy can now record dictated prompts and send them to `agentd` for local transcription before the user submits the final message. The daemon accepts recorded audio uploads on a new transcription endpoint, stores the audio locally, converts it to a Whisper-compatible format with `ffmpeg`, and returns the transcribed text so Buddy can prefill the prompt composer for review and editing.

  `asynq-agentctl` now includes `speech status` and `speech setup` commands so existing installs can configure local Whisper transcription later without rerunning the whole installer. The installer also best-effort calls this setup flow automatically unless explicitly skipped.

## 0.7.0

## 0.6.0

## 0.5.2

## 0.5.1

## 0.5.0

## 0.4.6

## 0.4.5

## 0.4.4

## 0.4.3

## 0.4.2

## 0.4.1

## 0.4.0

### Minor Changes

- Add a much richer operator runtime for Buddy and local agent workflows. - Improve recent-work ingestion for Codex and Claude Code with stable thread titles, observed-vs-managed state, background refresh, imported activity updates, and a dedicated recent-work detail API that serves summaries, raw communication, and changed files from cached data. - Add model-backed continuation summarization with provider-aware batching, summary caching, debug logging, and better fallback behavior so continue cards and details can stay useful while transcripts evolve. - Expand the daemon dashboard surface with managed session/review counts, runtime discovery, richer approval review payloads, and cleaner continue-working responses for mobile and dashboard clients. - Extend `asynq-agentctl` with daemon lifecycle commands, structured log access with follow mode, and persistent summary debug toggles to make local operations and debugging easier. - Harden local runtime behavior with improved config migration, rotating daemon log files, better simulator/local-network ergonomics, and more reliable event-driven refresh paths for observed work.

## 0.3.0

### Minor Changes

- Improve the public operator surface with usage and API contract docs, richer `asynq-agentctl` commands for approvals, recent work, and auth token handling, plus better cross-platform path handling, workflow reliability, and a clearer landing page for `agentd.asynq.org`.

All notable changes to the `asynq-agentctl` package will be documented in this file.

For release context that spans the whole workspace, see the root-level [`CHANGELOG.md`](../../CHANGELOG.md).
