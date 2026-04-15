---
"asynq-agentd": minor
---

Add Codex observed-review continuation support.

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
