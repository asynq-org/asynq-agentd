import type { DaemonConfig } from "../domain.ts";
import { createDefaultConfig } from "../config.ts";
import type { AsynqAgentdStorage } from "../db/storage.ts";
import { ProjectConfigService } from "./project-config-service.ts";

export class ConfigService {
  private readonly storage: AsynqAgentdStorage;
  private readonly projectConfig: ProjectConfigService;

  constructor(storage: AsynqAgentdStorage, projectConfig = new ProjectConfigService()) {
    this.storage = storage;
    this.projectConfig = projectConfig;
  }

  get(): DaemonConfig {
    const existing = this.storage.getConfig();
    if (existing) {
      return existing;
    }

    return this.storage.saveConfig(createDefaultConfig());
  }

  update(patch: Partial<DaemonConfig>): DaemonConfig {
    const current = this.get();
    const merged: DaemonConfig = {
      ...current,
      ...patch,
      approval: {
        ...current.approval,
        ...(patch.approval ?? {}),
      },
      model_routing: {
        ...current.model_routing,
        ...(patch.model_routing ?? {}),
      },
    };

    return this.storage.saveConfig(merged);
  }

  getEffective(projectPath?: string): DaemonConfig {
    const globalConfig = this.get();
    if (!projectPath) {
      return globalConfig;
    }

    const projectConfig = this.projectConfig.load(projectPath);
    return {
      ...globalConfig,
      approval: {
        ...globalConfig.approval,
        ...(projectConfig.approval ?? {}),
      },
      model_routing: {
        ...globalConfig.model_routing,
        ...(projectConfig.model_routing ?? {}),
      },
    };
  }
}
