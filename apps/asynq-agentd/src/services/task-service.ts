import { isAbsolute } from "node:path";
import { createId } from "../utils/id.ts";
import { nowIso } from "../utils/time.ts";
import { TASK_PRIORITIES, TASK_STATUSES, type ProjectConfigRecord, type TaskRecord } from "../domain.ts";
import type { AsynqAgentdStorage } from "../db/storage.ts";
import { getNextRunAt } from "../utils/schedule.ts";
import { ProjectConfigService } from "./project-config-service.ts";

export interface CreateTaskInput {
  title: string;
  description: string;
  agent_type?: TaskRecord["agent_type"];
  project_path: string;
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
    const projectConfig = this.projectConfig.load(input.project_path);
    const task: TaskRecord = {
      id: createId("task"),
      title: input.title,
      description: input.description,
      agent_type: input.agent_type ?? "custom",
      project_path: input.project_path,
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

  private validateCreateInput(input: CreateTaskInput): void {
    if (!input.title?.trim()) {
      throw new Error("Task title is required");
    }

    if (!input.description?.trim()) {
      throw new Error("Task description is required");
    }

    if (!input.project_path || !isAbsolute(input.project_path)) {
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
    if (patch.project_path && !isAbsolute(patch.project_path)) {
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
}
