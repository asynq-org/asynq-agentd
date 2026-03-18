import { createId } from "../utils/id.ts";
import { nowIso } from "../utils/time.ts";
import type { ActivityPayload, ApprovalRecord, SessionRecord, TaskRecord } from "../domain.ts";
import type { AsynqAgentdStorage } from "../db/storage.ts";
import { EventStreamService } from "./event-stream-service.ts";

interface SessionControl {
  sendMessage?: (message: string) => void;
  writeInput?: (input: string) => void;
  resize?: (cols: number, rows: number) => void;
  stop?: () => void;
}

export class SessionService {
  private readonly storage: AsynqAgentdStorage;
  private readonly controls = new Map<string, SessionControl>();
  private readonly events?: EventStreamService;

  constructor(storage: AsynqAgentdStorage, events?: EventStreamService) {
    this.storage = storage;
    this.events = events;
  }

  list(): SessionRecord[] {
    return this.storage.listSessions();
  }

  get(id: string) {
    return this.storage.getSessionDetail(id);
  }

  getRecord(id: string): SessionRecord | undefined {
    return this.storage.getSession(id);
  }

  createFromTask(task: TaskRecord, adapterName: string): SessionRecord {
    const createdAt = nowIso();
    const session: SessionRecord = {
      id: createId("sess"),
      task_id: task.id,
      title: task.title,
      agent_type: task.agent_type,
      project_path: task.project_path,
      branch: task.branch,
      state: "working",
      adapter: adapterName,
      created_at: createdAt,
      updated_at: createdAt,
      metadata: {},
    };
    this.storage.upsertSession(session);
    this.recordEvent(session.id, { type: "session_state_change", from: "unknown", to: "working" });
    return session;
  }

  update(session: SessionRecord): SessionRecord {
    return this.storage.upsertSession({
      ...session,
      updated_at: nowIso(),
    });
  }

  mergeMetadata(sessionId: string, patch: Record<string, unknown>): SessionRecord {
    const current = this.storage.getSession(sessionId);
    if (!current) {
      throw new Error(`Session ${sessionId} not found`);
    }

    return this.update({
      ...current,
      metadata: {
        ...(current.metadata ?? {}),
        ...patch,
      },
    });
  }

  registerControl(sessionId: string, control: SessionControl): void {
    this.controls.set(sessionId, control);
  }

  unregisterControl(sessionId: string): void {
    this.controls.delete(sessionId);
  }

  transition(sessionId: string, nextState: SessionRecord["state"]): SessionRecord {
    const current = this.storage.getSession(sessionId);
    if (!current) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (current.state === nextState) {
      return current;
    }

    const updated = this.storage.upsertSession({
      ...current,
      state: nextState,
      updated_at: nowIso(),
    });

    this.recordEvent(sessionId, {
      type: "session_state_change",
      from: current.state,
      to: nextState,
    });
    this.events?.publish({
      kind: "session",
      session_id: sessionId,
      created_at: updated.updated_at,
      payload: {
        state: nextState,
        adapter: updated.adapter,
      },
    });

    return updated;
  }

  recordEvent(sessionId: string, payload: ActivityPayload) {
    const createdAt = nowIso();
    const inserted = this.storage.insertActivity(sessionId, createdAt, payload);
    this.events?.publish({
      kind: "activity",
      session_id: sessionId,
      created_at: createdAt,
      payload,
    });
    return inserted;
  }

  requestApproval(sessionId: string, action: string, context: string): ApprovalRecord {
    const approval: ApprovalRecord = {
      id: createId("approval"),
      session_id: sessionId,
      action,
      context,
      status: "pending",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.storage.upsertApproval(approval);
    this.transition(sessionId, "waiting_approval");
    this.recordEvent(sessionId, { type: "approval_requested", action, context });
    return approval;
  }

  resolveApproval(id: string, decision: "approved" | "rejected", note?: string): ApprovalRecord {
    const current = this.storage.getApproval(id);
    if (!current) {
      throw new Error(`Approval ${id} not found`);
    }

    const updated: ApprovalRecord = {
      ...current,
      status: decision,
      note,
      updated_at: nowIso(),
    };

    this.storage.upsertApproval(updated);
    this.recordEvent(current.session_id, {
      type: "approval_resolved",
      action: current.action,
      decision,
    });
    this.transition(current.session_id, decision === "approved" ? "working" : "errored");
    return updated;
  }

  sendMessage(sessionId: string, message: string): void {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const control = this.controls.get(sessionId);
    if (control?.sendMessage) {
      control.sendMessage(message);
      return;
    }

    this.recordEvent(sessionId, {
      type: "agent_thinking",
      summary: `Operator message received: ${message}`,
    });
  }

  writeInput(sessionId: string, input: string): void {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const control = this.controls.get(sessionId);
    if (!control?.writeInput) {
      throw new Error(`Session ${sessionId} does not support live terminal input`);
    }

    control.writeInput(input);
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): SessionRecord {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const control = this.controls.get(sessionId);
    control?.resize?.(cols, rows);

    return this.mergeMetadata(sessionId, {
      terminal_size: { cols, rows },
      terminal_resized_at: nowIso(),
    });
  }

  stop(sessionId: string): SessionRecord {
    const control = this.controls.get(sessionId);
    if (control?.stop) {
      control.stop();
      this.recordEvent(sessionId, {
        type: "agent_thinking",
        summary: "Operator requested session stop.",
      });
    }

    return this.transition(sessionId, "completed");
  }
}
