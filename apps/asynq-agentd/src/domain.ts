export const SESSION_STATES = ["idle", "working", "waiting_approval", "errored", "completed"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ["queued", "running", "paused", "completed", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type AgentType = "claude-code" | "codex" | "opencode" | "custom";

export interface TaskContext {
  previous_session_id?: string;
  files_to_focus?: string[];
  test_command?: string;
}

export interface ProjectConfigRecord {
  name?: string;
  test_command?: string;
  lint_command?: string;
  watch_branches?: string[];
  auto_handoff_prompt?: boolean;
  context_files?: string[];
  default_model_preference?: string;
  default_approval_required?: boolean;
  approval?: Partial<DaemonConfig["approval"]>;
  model_routing?: Partial<DaemonConfig["model_routing"]>;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  agent_type: AgentType;
  project_path: string;
  branch?: string;
  priority: TaskPriority;
  depends_on: string[];
  approval_required: boolean;
  model_preference?: string;
  schedule?: string;
  context?: TaskContext;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  assigned_session_id?: string;
  next_run_at?: string;
  last_run_at?: string;
}

export interface SessionRecord {
  id: string;
  task_id?: string;
  title: string;
  agent_type: AgentType;
  project_path: string;
  branch?: string;
  state: SessionState;
  adapter: string;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalRecord {
  id: string;
  session_id: string;
  action: string;
  context: string;
  status: "pending" | "approved" | "rejected";
  note?: string;
  created_at: string;
  updated_at: string;
}

export type ActivityPayload =
  | { type: "command_intent"; cmd: string; source: "tool_call" | "custom_tool_call" }
  | { type: "file_edit"; path: string; lines_added: number; lines_removed: number }
  | { type: "file_create"; path: string }
  | { type: "file_delete"; path: string }
  | {
    type: "file_batch_intent";
    summary: string;
    files: Array<
      | { path: string; action: "created" | "deleted" }
      | { path: string; action: "edited"; lines_added: number; lines_removed: number }
    >;
  }
  | {
    type: "file_batch";
    summary: string;
    files: Array<
      | { path: string; action: "created" | "deleted" }
      | { path: string; action: "edited"; lines_added: number; lines_removed: number }
    >;
  }
  | { type: "command_run"; cmd: string; exit_code: number; duration_ms: number; stdout_preview?: string }
  | { type: "test_run"; passed: number; failed: number; skipped: number; duration_ms: number }
  | { type: "model_call"; model: string; tokens_in: number; tokens_out: number; cost_usd: number }
  | { type: "approval_requested"; action: string; context: string }
  | { type: "approval_resolved"; action: string; decision: "approved" | "rejected" }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "agent_thinking"; summary: string }
  | { type: "session_state_change"; from: SessionState | "unknown"; to: SessionState };

export interface ActivityRecord {
  id: number;
  session_id: string;
  created_at: string;
  payload: ActivityPayload;
}

export interface TerminalChunkRecord {
  id: number;
  session_id: string;
  created_at: string;
  stream: "stdin" | "stdout" | "stderr";
  chunk: string;
}

export interface DaemonConfig {
  auth_token: string;
  max_parallel_sessions: number;
  approval: {
    always_require: string[];
    never_require: string[];
    cost_threshold: number;
    timeout_minutes: number;
  };
  model_routing: {
    default: string;
    fallback: string;
  };
  summaries: {
    enabled: boolean;
    provider: "auto" | "claude" | "codex" | "heuristic" | "none";
    model?: string;
    max_input_chars: number;
    debug: boolean;
  };
}

export interface SessionDetail extends SessionRecord {
  task?: TaskRecord;
  recent_events: ActivityRecord[];
}

export interface StatsSnapshot {
  sessions_total: number;
  sessions_active: number;
  tasks_total: number;
  tasks_completed: number;
  tasks_failed: number;
  approvals_pending: number;
  model_cost_usd: number;
}

export interface RecentWorkRecord {
  id: string;
  source_path: string;
  project_path?: string;
  title: string;
  summary?: string;
  source_type: "claude-session" | "claude-file" | "codex-session-index" | "codex-session-file";
  status: "active" | "ended" | "unknown";
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface RecentWorkListItem extends RecentWorkRecord {
  activity_preview?: ActivityRecord[];
}

export interface SummaryCacheRecord {
  key: string;
  scope: "session_card" | "continue_card" | "approval_review";
  entity_id: string;
  session_id?: string;
  input_hash: string;
  provider: string;
  content: Record<string, unknown>;
  updated_at: string;
}

export interface RuntimeAdapterAvailability {
  id: AgentType;
  adapter: string;
  available: boolean;
  path?: string;
  mode: "real" | "mock" | "binary-detected-but-daemon-mock";
}
