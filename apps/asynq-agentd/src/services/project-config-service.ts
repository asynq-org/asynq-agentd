import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { ProjectConfigRecord } from "../domain.ts";

interface ParsedProjectConfigFile {
  project?: ProjectConfigRecord;
}

export class ProjectConfigService {
  load(projectPath: string): ProjectConfigRecord {
    const configPath = resolve(projectPath, ".asynq-agentd.yaml");
    if (!existsSync(configPath)) {
      return {};
    }

    const parsed = parse(readFileSync(configPath, "utf8")) as ParsedProjectConfigFile | null;
    return parsed?.project ?? {};
  }
}
