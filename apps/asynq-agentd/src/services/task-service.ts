import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createId } from "../utils/id.ts";
import { nowIso } from "../utils/time.ts";
import { TASK_PRIORITIES, TASK_STATUSES, type ProjectConfigRecord, type SessionRecord, type TaskRecord } from "../domain.ts";
import type { AsynqAgentdStorage } from "../db/storage.ts";
import { getNextRunAt } from "../utils/schedule.ts";
import { ProjectConfigService } from "./project-config-service.ts";

export interface CreateTaskInput {
  title: string;
  description: string;
  agent_type?: TaskRecord["agent_type"];
  project_path?: string;
  branch?: string;
  priority?: TaskRecord["priority"];
  depends_on?: string[];
  approval_required?: boolean;
  model_preference?: string;
  schedule?: string;
  context?: TaskRecord["context"];
}

export class TaskService {
  private readonly storage: AsynqAgentdStorage;
  private readonly projectConfig: ProjectConfigService;

  constructor(storage: AsynqAgentdStorage, projectConfig = new ProjectConfigService()) {
    this.storage = storage;
    this.projectConfig = projectConfig;
  }

  list(): TaskRecord[] {
    return this.storage.listTasks();
  }

  get(id: string): TaskRecord | undefined {
    return this.storage.getTask(id);
  }

  create(input: CreateTaskInput): TaskRecord {
    this.validateCreateInput(input);
    const createdAt = nowIso();
    const projectPath = this.resolveProjectPath(input.project_path);
    const projectConfig = this.projectConfig.load(projectPath);
    const task: TaskRecord = {
      id: createId("task"),
      title: input.title,
      description: input.description,
      agent_type: input.agent_type ?? "custom",
      project_path: projectPath,
      branch: input.branch,
      priority: input.priority ?? "normal",
      depends_on: input.depends_on ?? [],
      approval_required: input.approval_required ?? projectConfig.default_approval_required ?? false,
      model_preference: input.model_preference ?? projectConfig.default_model_preference,
      schedule: input.schedule,
      context: this.mergeContext(input.context, projectConfig),
      status: "queued",
      created_at: createdAt,
      updated_at: createdAt,
      next_run_at: input.schedule ? getNextRunAt(input.schedule) : undefined,
    };

    return this.storage.upsertTask(task);
  }

  update(id: string, patch: Partial<Omit<TaskRecord, "id" | "created_at">>): TaskRecord {
    const current = this.storage.getTask(id);
    if (!current) {
      throw new Error(`Task ${id} not found`);
    }

    this.validateUpdatePatch(current, patch);

    const updated: TaskRecord = {
      ...current,
      ...patch,
      context: this.mergeContext(patch.context ?? current.context, this.projectConfig.load(patch.project_path ?? current.project_path)),
      next_run_at: this.resolveNextRunAt(current, patch),
      updated_at: nowIso(),
    };

    return this.storage.upsertTask(updated);
  }

  delete(id: string): boolean {
    return this.storage.deleteTask(id);
  }

  deleteManagedSessionTree(sessionId: string): { deleted_session_ids: string[]; deleted_task_ids: string[] } {
    const { rootSession, rootTask } = this.resolveStandaloneManagedDeleteRoot(sessionId);

    const tasks = this.storage.listTasks();
    const sessions = this.storage.listSessions();
    const deletedSessionIds = new Set<string>();
    const deletedTaskIds = new Set<string>();
    const queue = [rootSession.id];

    while (queue.length > 0) {
      const currentSessionId = queue.shift()!;
      if (deletedSessionIds.has(currentSessionId)) {
        continue;
      }

      deletedSessionIds.add(currentSessionId);
      const childTasks = tasks.filter((task) => task.context?.parent_session_id === currentSessionId);
      for (const childTask of childTasks) {
        deletedTaskIds.add(childTask.id);
        if (childTask.assigned_session_id) {
          queue.push(childTask.assigned_session_id);
        }
      }
    }

    deletedTaskIds.add(rootTask.id);

    for (const sessionId of deletedSessionIds) {
      this.storage.deleteApprovalsForSession(sessionId);
      this.storage.deleteActivityForSession(sessionId);
      this.storage.deleteTerminalEventsForSession(sessionId);
      this.storage.deleteSummaryCacheForSession(sessionId);
      this.storage.deleteSession(sessionId);
    }

    for (const taskId of deletedTaskIds) {
      this.storage.deleteTask(taskId);
    }

    return {
      deleted_session_ids: [...deletedSessionIds],
      deleted_task_ids: [...deletedTaskIds],
    };
  }

  canDeleteManagedSession(sessionId: string): boolean {
    try {
      this.resolveStandaloneManagedDeleteRoot(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  private validateCreateInput(input: CreateTaskInput): void {
    if (!input.title?.trim()) {
      throw new Error("Task title is required");
    }

    if (!input.description?.trim()) {
      throw new Error("Task description is required");
    }

    if (input.project_path && !this.isSupportedProjectPath(input.project_path)) {
      throw new Error("Task project_path must be an absolute path");
    }

    if (input.priority && !TASK_PRIORITIES.includes(input.priority)) {
      throw new Error(`Unsupported priority: ${input.priority}`);
    }

    if (input.schedule) {
      getNextRunAt(input.schedule);
    }
  }

  private validateUpdatePatch(current: TaskRecord, patch: Partial<Omit<TaskRecord, "id" | "created_at">>): void {
    if (patch.project_path && !this.isSupportedProjectPath(patch.project_path)) {
      throw new Error("Task project_path must be an absolute path");
    }

    if (patch.priority && !TASK_PRIORITIES.includes(patch.priority)) {
      throw new Error(`Unsupported priority: ${patch.priority}`);
    }

    if (patch.status && !TASK_STATUSES.includes(patch.status)) {
      throw new Error(`Unsupported status: ${patch.status}`);
    }

    if (patch.schedule) {
      getNextRunAt(patch.schedule);
    }

    const nextDependsOn = patch.depends_on ?? current.depends_on;
    if (nextDependsOn.includes(current.id)) {
      throw new Error("Task cannot depend on itself");
    }
  }

  private mergeContext(context: TaskRecord["context"], projectConfig: ProjectConfigRecord): TaskRecord["context"] {
    const merged: TaskRecord["context"] = {
      ...(context ?? {}),
    };

    if (!merged.test_command && projectConfig.test_command) {
      merged.test_command = projectConfig.test_command;
    }

    if (projectConfig.context_files?.length) {
      merged.files_to_focus = Array.from(new Set([
        ...(projectConfig.context_files ?? []),
        ...(merged.files_to_focus ?? []),
      ]));
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private resolveNextRunAt(current: TaskRecord, patch: Partial<Omit<TaskRecord, "id" | "created_at">>): string | undefined {
    if (patch.schedule === undefined) {
      return patch.next_run_at ?? current.next_run_at;
    }

    if (!patch.schedule) {
      return undefined;
    }

    return getNextRunAt(patch.schedule);
  }

  private isSupportedProjectPath(projectPath: string): boolean {
    return isAbsolute(projectPath) || projectPath.startsWith("~/");
  }

  private resolveStandaloneManagedDeleteRoot(sessionId: string): { rootSession: SessionRecord; rootTask: TaskRecord } {
    let currentSession = this.storage.getSession(sessionId);
    if (!currentSession) {
      throw new Error(`Session ${sessionId} not found`);
    }

    let currentTask = currentSession.task_id ? this.storage.getTask(currentSession.task_id) : undefined;
    if (!currentTask) {
      throw new Error(`Session ${sessionId} is missing its task`);
    }

    const visited = new Set<string>();

    while (true) {
      if (visited.has(currentSession.id)) {
        throw new Error("Managed session chain is cyclic");
      }
      visited.add(currentSession.id);

      if (currentTask.context?.source_recent_work_id) {
        throw new Error("Observed takeover managed sessions cannot be deleted from Buddy");
      }

      const parentSessionId = currentTask.context?.parent_session_id;
      if (!parentSessionId) {
        return { rootSession: currentSession, rootTask: currentTask };
      }

      const parentSession = this.storage.getSession(parentSessionId);
      if (!parentSession) {
        throw new Error(`Parent session ${parentSessionId} not found`);
      }

      const parentTask = parentSession.task_id ? this.storage.getTask(parentSession.task_id) : undefined;
      if (!parentTask) {
        throw new Error(`Parent session ${parentSessionId} is missing its task`);
      }

      currentSession = parentSession;
      currentTask = parentTask;
    }
  }

  private resolveProjectPath(projectPath?: string): string {
    const trimmed = projectPath?.trim();
    const resolved = !trimmed
      ? join(homedir(), ".asynq-agentd", "workspaces", "general")
      : trimmed.startsWith("~/")
        ? join(homedir(), trimmed.slice(2))
        : trimmed;

    mkdirSync(resolved, { recursive: true });
    return resolved;
  }
}
