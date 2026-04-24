# Changelog

## 0.8.7

### Patch Changes

- Improve installer UX during longer background steps by printing progress-oriented status messages.

  The Unix installer now announces longer waits such as Tailscale hostname detection, auth token creation, daemon API readiness, service reloads, and speech setup. This makes the hosted install flow feel less stalled during 5-15 second background operations and reduces the chance that users interrupt a healthy install because the terminal appears frozen.

## 0.8.6

### Patch Changes

- Wait for the local daemon API before installer pairing, and retry automatic TLS enablement during pairing bootstrap.

  The installer now waits until `asynq-agentctl status` reports the daemon as reachable before opening the Buddy pairing flow, instead of relying on `auth.json` alone. Automatic HTTPS pairing also retries the local `PATCH /config` request for a few seconds before falling back, which reduces startup races that previously left Tailscale installs on plain HTTP and caused Buddy to pair against an unusable IP endpoint.

## 0.8.5

### Patch Changes

- Wait for the local daemon API before running installer pairing and TLS bootstrap.

  The Unix installer no longer treats the presence of `auth.json` as enough to start Buddy pairing. It now waits until `asynq-agentctl status` reports the daemon as reachable, which avoids early `fetch failed` errors during automatic HTTPS enablement and reduces cases where the installer leaves the public pairing URL on plain HTTP even though TLS cert material is already available.

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

### Patch Changes

- Fix stale observed sessions reporting as currently working after a crash or forced process kill.

  `agentd` now reports observed `is_working` from recent-work freshness instead of treating every `status: "active"` record as still running. This keeps Buddy's `Working` counter aligned with real live work after OOMs, restarts, or abruptly terminated desktop agent processes.

## 0.8.0

### Minor Changes

- Add local voice-prompt transcription support for Buddy.

  Buddy can now record dictated prompts and send them to `agentd` for local transcription before the user submits the final message. The daemon accepts recorded audio uploads on a new transcription endpoint, stores the audio locally, converts it to a Whisper-compatible format with `ffmpeg`, and returns the transcribed text so Buddy can prefill the prompt composer for review and editing.

  `asynq-agentctl` now includes `speech status` and `speech setup` commands so existing installs can configure local Whisper transcription later without rerunning the whole installer. The installer also best-effort calls this setup flow automatically unless explicitly skipped.

## 0.7.0

### Minor Changes

- Add Codex observed-review continuation support.

  Codex observed approvals can now fall back to a same-thread `codex exec resume`
  continuation when a live approval bridge is not available. Buddy labels this flow
  as "Continue in Codex" / "Reject in Codex" instead of presenting it as a true
  desktop approval, and the daemon warns that the original Codex Desktop prompt may
  remain open and should be cancelled later.

  The macOS GUI bridge remains available as an experimental path, but it is now
  opt-in via `ASYNQ_AGENTD_CODEX_GUI_BRIDGE=1` so installations are not prompted for
  Accessibility permissions unless explicitly enabled.

  Headless Codex continuations can now request the next permission-sensitive step
  using a structured `NEXT_APPROVAL_REQUIRED` response. The daemon stores that as a
  follow-up Buddy approval for the same observed thread, allowing users to approve
  multi-step Codex work one step at a time without guessing the required scope in
  advance.

- Add screenshot attachments for managed-session prompts and follow-up messages.

  Buddy can now send image attachments when creating managed sessions, continuing managed sessions, or taking over observed work. The daemon stores the uploaded screenshots under the local agentd attachment directory and appends compact screenshot context to the prompt so the runtime can use the images without embedding large base64 payloads into the conversation itself.

- Add Claude Code observed-review continuation support.

  Claude Code observed approvals can now use the same headless same-thread continuation flow as Codex when Buddy cannot click the original desktop prompt directly. The daemon sends the operator decision through `claude -p --resume`, tracks the final Claude response, and stores follow-up `NEXT_APPROVAL_REQUIRED` requests so multi-step Claude work can be approved from Buddy one step at a time.

  Recurring tasks now keep a compact per-task run history in task context. Each scheduled run records a short status summary, recent changed work, and whether it completed or failed; future runs receive this compact history in their prompt so recurring agents can avoid duplicating previous output.

## 0.6.0

### Minor Changes

- Improve managed-session parent/child navigation and add observed in-place resolution workflow.

  - Add observed approval resolution strategy handling (`auto`, `in_place`, `managed_handoff`) with in-place relay + verification and safe fallback behavior.
  - Extend approval resolve request handling for observed approvals with strategy and verification controls.
  - Keep managed parent sessions visible in dashboard lists and expose explicit managed parent linkage for continuation chains.
  - Improve managed session detail/source metadata so Buddy can open real parent sessions instead of unavailable placeholders.

## 0.5.2

### Patch Changes

- Add markdown export support for managed/continue outputs:

  - `POST /exports/markdown` saves output to `<project>/.asynq-exports/*.md` and returns the saved path.
  - `POST /exports/open` opens/reveals a saved export file on the host Mac.
  - Export automatically adds `.asynq-exports/` to the project's `.gitignore` when `.gitignore` exists and the entry is missing.

## 0.5.1

### Patch Changes

- Fix Codex managed sessions getting stuck at `Reading additional input from stdin...` in pipe mode.

  The daemon now closes child stdin after launching non-interactive Codex runs (with an opt-out for explicit live-stdin tests), so new managed sessions start processing immediately instead of waiting indefinitely for stdin EOF.

## 0.5.0

### Minor Changes

- Fix broken pairing QR code

  - Add in-browser QR code as default QR for Buddy pairing
  - Add support for https
  - Make https mandatory for iOS

## 0.4.6

### Patch Changes

- Fix broken self-update logic.

  - Add `--skip-service-reload` so self-update does not stop the running daemon inside installer before explicit restart.

## 0.4.5

### Patch Changes

- Fix broken self-update logic.

  - Detect daemon version from `apps/asynq-agentd/package.json` instead of a stale hardcoded value.
  - Pin self-update installs to the detected latest release tag (`ASYNQ_AGENTD_REF=vX.Y.Z`) and fall back to `asynq-agentctl start` if restart is unavailable.

## 0.4.4

### Patch Changes

- Improve update release notes so Buddy shows structured changelog content.

  - Parse `asynq-agentd@...` blocks with `Major/Minor/Patch Changes` from release content.
  - Follow linked GitHub PR URLs and extract structured notes from PR descriptions when needed.
  - Preserve multiline formatting in release notes for better in-app readability.
  - Use a persistent checkout path in the hosted installer so self-update restart does not point wrappers at a deleted temp directory.
  - Include `daemon.version` in `asynq-agentctl status` output (or `null` when unreachable).
  - Add installer flags for unattended updates (`--reuse-config --non-interactive --skip-pairing`) and make self-update use them by default.

## 0.4.3

### Patch Changes

- Improve update release notes so Buddy shows structured changelog content.

  - Parse `asynq-agentd@...` blocks with `Major/Minor/Patch Changes` from release content.
  - Follow linked GitHub PR URLs and extract structured notes from PR descriptions when needed.
  - Preserve multiline formatting in release notes for better in-app readability.

## 0.4.2

### Patch Changes

- Refresh the agentd landing page and docs to match the Buddy aesthetic and to point at the new homes.

  - redesign `site/index.html` and `site/styles.css` with the warm Buddy palette, animated buddy mark, terminal hero, install cards, feature grid, Buddy promo, and docs grid
  - point Buddy CTAs and footer link at `https://buddy.asynq.org`
  - expand `docs/architecture.md` with goals, an ASCII component diagram, daemon/CLI/adapter/storage/transport breakdowns, data flow, configuration, and rationale
  - add a small nav header (landing · sibling docs · Buddy · Apache 2.0) to `docs/api.md`, `docs/usage.md`, and `docs/architecture.md`, and mention Buddy in the api/usage intros

## 0.4.1

### Patch Changes

- Improve observed and managed Codex session handling across recent work, reviews, and takeovers.

  - keep observed recent-work cards stable when managed follow-ups complete, including better filtering of stale managed continuations and internal relay artifacts
  - refresh recent work from disk before serving dashboard detail so newer Codex transcript content shows up reliably
  - detect observed Codex approval requests and surface them in attention-required views, with takeover support classified as Buddy-managed or desktop-only
  - relay managed handoff summaries back into observed Codex threads without reusing the managed execution session itself
  - tighten observed takeovers by carrying structured command context and success checks, and avoid marking managed takeovers complete when verification fails
  - improve Codex managed continuation resume behavior by persisting thread ids from `thread.started` events and strengthening fallback continuation context
  - allow deleting standalone managed session chains from Buddy, including continuation trees rooted at the visible managed session

## 0.4.0

### Minor Changes

- Add a much richer operator runtime for Buddy and local agent workflows. - Improve recent-work ingestion for Codex and Claude Code with stable thread titles, observed-vs-managed state, background refresh, imported activity updates, and a dedicated recent-work detail API that serves summaries, raw communication, and changed files from cached data. - Add model-backed continuation summarization with provider-aware batching, summary caching, debug logging, and better fallback behavior so continue cards and details can stay useful while transcripts evolve. - Expand the daemon dashboard surface with managed session/review counts, runtime discovery, richer approval review payloads, and cleaner continue-working responses for mobile and dashboard clients. - Extend `asynq-agentctl` with daemon lifecycle commands, structured log access with follow mode, and persistent summary debug toggles to make local operations and debugging easier. - Harden local runtime behavior with improved config migration, rotating daemon log files, better simulator/local-network ergonomics, and more reliable event-driven refresh paths for observed work.

## 0.3.0

### Minor Changes

- Improve the public operator surface with usage and API contract docs, richer `asynq-agentctl` commands for approvals, recent work, and auth token handling, plus better cross-platform path handling, workflow reliability, and a clearer landing page for `agentd.asynq.org`.

All notable changes to the `asynq-agentd` package will be documented in this file.

For release context that spans the whole workspace, see the root-level [`CHANGELOG.md`](../../CHANGELOG.md).
