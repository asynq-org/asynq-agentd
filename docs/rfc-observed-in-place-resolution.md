# RFC: In-place resolution for observed session reviews (with managed hand-off fallback)

Status: Draft

Owner: asynq-agentd

Last updated: 2026-04-15

## 1. Context

Today, observed-session reviews from Buddy are resolved by creating a managed takeover session, then relaying a hand-off note back to the observed thread.

This works functionally, but UX is incomplete:

- the original desktop thread often still looks blocked to the operator,
- the operator may return to Codex/Claude and see a stale pending state,
- Buddy solved the issue, but the source thread does not look obviously "done".

Goal: resolve observed reviews directly in the source session when possible ("in-place"), while preserving current managed hand-off as the final fallback.

## 2. Problem statement

When Buddy resolves an observed review, the source thread should reflect the outcome as if the operator handled it there. If in-place resolution fails or is unsupported, the daemon must automatically fall back to the existing managed hand-off flow.

## 3. Goals

1. Preserve current reliability by keeping managed hand-off as fallback.
2. Add adapter-level capability for in-place observed resolution.
3. Verify resolution outcome before declaring success.
4. Provide clear, auditable method metadata (`in_place` vs `managed_handoff`).
5. Keep API backward compatible for existing Buddy builds.

## 4. Non-goals

1. No mandatory GUI click automation in v1.
2. No attempt to generalize to all runtime actions in v1 (scope is observed review resolution).
3. No removal of managed hand-off path.

## 5. Current runtime capability snapshot

Based on current `asynq-agentd` code:

1. Codex
- Has adapter-level conversation write-back primitive (`appendToConversation`).
- Suitable as the first in-place target.

2. Claude Code
- Has robust CLI run/resume path, but no adapter `appendToConversation` equivalent yet.
- Needs adapter extension for in-place parity.

3. Claude Cowork (`claude-desktop-session` observed source)
- Observed ingest exists.
- No stable write-back bridge in current daemon implementation.
- Should stay managed-fallback-only until a safe bridge exists.

## 6. Proposed architecture

### 6.1 New capability contract

Extend adapter capability model with optional in-place resolver:

- `resolveObservedReview?(input): Promise<ObservedResolutionResult>`
- `supportsObservedInPlaceResolution?: boolean`

Suggested input shape:

- `sourceSessionId: string`
- `recentWorkId: string`
- `decision: "approved" | "rejected"`
- `note?: string`
- `projectPath?: string`
- `verificationHints?: { command?: string; files?: string[] }`

Suggested result shape:

- `accepted: boolean`
- `operationId?: string`
- `message?: string`
- `metadata?: Record<string, unknown>`

### 6.2 Resolution orchestrator (new service)

Add `ObservedResolutionService` that implements:

1. Determine source runtime + capability.
2. Attempt in-place resolution when allowed.
3. Run verification window.
4. If unverified/failed/unsupported -> invoke existing managed hand-off flow.
5. Persist attempt + emit events.

### 6.3 Verification policy

In-place attempt is only `resolved` if verified within timeout.

Verification signals (ordered):

1. Source approval no longer pending in refreshed observed activity.
2. Expected command/run signal observed after decision.
3. Session state/progress moved forward.

If no signal by timeout => `unverified` => fallback.

## 7. API changes (backward compatible)

### 7.1 Extend `POST /approvals/:id`

Current body remains valid:

```json
{ "decision": "approved", "note": "Looks good" }
```

Add optional fields:

```json
{
  "decision": "approved",
  "note": "Looks good",
  "resolution_strategy": "auto",
  "require_verification": true
}
```

`resolution_strategy`:

1. `auto` (default for observed approvals): try in-place then fallback.
2. `in_place`: try in-place only; fail if unsupported/unverified.
3. `managed_handoff`: skip in-place and use existing flow.

### 7.2 Response extension

Add resolution metadata:

```json
{
  "ok": true,
  "approval_id": "observed-review:recent_123",
  "resolution": {
    "method": "in_place",
    "status": "verified",
    "fallback_used": false,
    "attempt_id": "obsres_..."
  }
}
```

Fallback case:

```json
{
  "ok": true,
  "resolution": {
    "method": "managed_handoff",
    "status": "queued",
    "fallback_used": true,
    "fallback_reason": "in_place_unverified",
    "attempt_id": "obsres_..."
  }
}
```

## 8. Data model additions

Add persistent attempt log table (name suggestion: `observed_resolution_attempts`):

- `id`
- `approval_id`
- `recent_work_id`
- `runtime`
- `requested_decision`
- `strategy_requested`
- `method_used` (`in_place` | `managed_handoff` | `none`)
- `status` (`accepted` | `verified` | `failed` | `fallback_queued`)
- `fallback_reason?`
- `metadata_json?`
- `created_at`
- `updated_at`

Also persist latest resolution snapshot in approval/recent-work metadata for UI surfaces.

## 9. Eventing

Emit explicit events for UI and audit:

1. `observed_resolution.started`
2. `observed_resolution.in_place.accepted`
3. `observed_resolution.verified`
4. `observed_resolution.fallback.queued`
5. `observed_resolution.failed`

These should be visible on SSE and WebSocket event streams.

## 10. UI contract impact (Buddy)

Buddy can render a deterministic status model:

1. `Resolving in source session...`
2. `Resolved in source session`
3. `Falling back to managed takeover...`
4. `Resolved via managed takeover`
5. `Resolution failed`

No breaking change is required; Buddy can adopt new fields progressively.

## 11. Runtime rollout plan

### Phase 0 (guardrails)

1. Feature flag default `managed_only`.
2. Add orchestrator + telemetry + DB table.
3. No behavior change yet.

### Phase 1 (Codex in-place)

1. Enable `auto` for observed Codex sources.
2. Use Codex adapter in-place resolver.
3. Verify + fallback on timeout/error.

### Phase 2 (Claude Code)

1. Add Claude adapter write-back primitive.
2. Enable `auto` for `claude-session` once verified in integration tests.

### Phase 3 (Cowork)

1. Add dedicated bridge only if stable and auditable control plane exists.
2. Until then: `managed_handoff` fallback path remains default for `claude-desktop-session`.

## 12. Config flags

Add config section (names illustrative):

```yaml
observed_resolution:
  mode: auto # managed_only | auto
  in_place_runtimes:
    - codex
  verification_timeout_ms: 15000
  fallback_on_unverified: true
```

Safe default in production: `managed_only` until runtime validated.

## 13. Failure modes and handling

1. Adapter unsupported
- skip directly to fallback in `auto`.

2. Adapter accepted but no verification
- mark unverified and fallback.

3. Source thread changed during attempt
- treat as conflict; fallback with reason `source_conflict`.

4. Fallback also fails
- return explicit error, keep full attempt trail.

## 14. Testing strategy

1. Unit tests
- orchestrator branch coverage (`in_place success`, `unsupported`, `timeout`, `fallback success/fail`).

2. Adapter tests
- Codex in-place operation success/failure fixtures.
- Claude adapter parity tests once added.

3. Service integration tests
- `POST /approvals/:id` with `resolution_strategy=auto` observed approval path.
- verify emitted events order.

4. Dashboard/Buddy contract tests
- ensure new resolution metadata appears in dashboard payloads without breaking existing fields.

## 15. Migration and compatibility

1. Existing Buddy clients keep working (same endpoint, same base semantics).
2. Existing managed hand-off implementation remains unchanged and reused as fallback engine.
3. New fields are additive; no required schema break on clients.

## 16. Open questions

1. Should `in_place` strategy be allowed from mobile by default, or only `auto`?
2. What exact verification threshold is acceptable per runtime?
3. Should we expose attempt history via a new endpoint for debugging (`GET /observed-resolution/:id`)?

## 17. Initial implementation checklist

1. Add `ObservedResolutionService` and wire `POST /approvals/:id`.
2. Add DB table + storage API for attempt log.
3. Add resolution events on stream.
4. Implement Codex adapter in-place resolver path.
5. Reuse existing managed hand-off path as fallback call.
6. Add tests for `auto` and `managed_handoff` strategies.
7. Update `docs/api.md` with additive request/response fields.
8. Update `docs/usage.md` with example observed resolution call.

---

This RFC intentionally keeps the current managed hand-off flow as the reliability backstop while enabling an incremental path toward true source-session resolution UX.
