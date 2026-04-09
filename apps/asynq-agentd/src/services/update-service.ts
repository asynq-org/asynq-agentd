import { spawn } from "node:child_process";
import { nowIso } from "../utils/time.ts";
import {
  AGENTD_VERSION,
  compareSemver,
  DEFAULT_GITHUB_RELEASES_URL,
  DEFAULT_INSTALL_COMMAND,
  DEFAULT_RESTART_COMMAND,
  MIN_SUPPORTED_BUDDY_VERSION,
  sanitizeVersion,
} from "../version.ts";

type UpdateFetch = typeof fetch;

type RunCommand = (command: string) => Promise<void>;

export type UpdateStatus = {
  current_version: string;
  latest_version?: string;
  checked_at?: string;
  status: "idle" | "checking" | "up_to_date" | "update_available" | "installing" | "restarting" | "failed";
  release_url?: string;
  release_notes?: string;
  error?: string;
  install_supported: boolean;
};

export type CompatibilityStatus = {
  agentd_version: string;
  app_version?: string;
  min_supported_buddy_version: string;
  min_supported_agentd_version?: string;
  requires_buddy_update: boolean;
  requires_agentd_update: boolean;
  app_store_url?: string;
};

type LatestReleaseResponse = {
  tag_name?: string;
  html_url?: string;
  body?: string;
};

function defaultRunCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      stdio: "ignore",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function truncateReleaseNotes(body: string | undefined, maxLength = 400): string | undefined {
  if (!body) {
    return undefined;
  }

  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export class UpdateService {
  private timer?: NodeJS.Timeout;
  private readonly currentVersion: string;
  private readonly releasesUrl: string;
  private readonly installCommand: string;
  private readonly restartCommand: string;
  private readonly fetchImpl: UpdateFetch;
  private readonly runCommand: RunCommand;
  private readonly minSupportedBuddyVersion: string;
  private readonly buddyAppStoreUrl?: string;
  private status: UpdateStatus;

  constructor(options?: {
    currentVersion?: string;
    releasesUrl?: string;
    installCommand?: string;
    restartCommand?: string;
    fetchImpl?: UpdateFetch;
    runCommand?: RunCommand;
    minSupportedBuddyVersion?: string;
    buddyAppStoreUrl?: string;
  }) {
    this.currentVersion = options?.currentVersion ?? AGENTD_VERSION;
    this.releasesUrl = options?.releasesUrl ?? process.env.ASYNQ_AGENTD_RELEASES_URL ?? DEFAULT_GITHUB_RELEASES_URL;
    this.installCommand = options?.installCommand ?? process.env.ASYNQ_AGENTD_SELF_UPDATE_COMMAND ?? DEFAULT_INSTALL_COMMAND;
    this.restartCommand = options?.restartCommand ?? process.env.ASYNQ_AGENTD_RESTART_COMMAND ?? DEFAULT_RESTART_COMMAND;
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.runCommand = options?.runCommand ?? defaultRunCommand;
    this.minSupportedBuddyVersion = options?.minSupportedBuddyVersion ?? MIN_SUPPORTED_BUDDY_VERSION;
    this.buddyAppStoreUrl = options?.buddyAppStoreUrl ?? process.env.ASYNQ_BUDDY_APP_STORE_URL ?? "https://apps.apple.com/us/search?term=Asynq%20Buddy";
    this.status = {
      current_version: this.currentVersion,
      status: "idle",
      install_supported: true,
    };
  }

  start(intervalMs = 60 * 60 * 1000): void {
    if (this.timer) {
      return;
    }

    void this.checkNow();
    this.timer = setInterval(() => {
      void this.checkNow();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  getCompatibility(client?: {
    app_version?: string;
    min_supported_agentd_version?: string;
  }): CompatibilityStatus {
    const appVersion = sanitizeVersion(client?.app_version);
    const minSupportedAgentdVersion = sanitizeVersion(client?.min_supported_agentd_version);

    return {
      agentd_version: this.currentVersion,
      app_version: appVersion,
      min_supported_buddy_version: this.minSupportedBuddyVersion,
      min_supported_agentd_version: minSupportedAgentdVersion,
      requires_buddy_update: Boolean(appVersion && compareSemver(appVersion, this.minSupportedBuddyVersion) < 0),
      requires_agentd_update: Boolean(minSupportedAgentdVersion && compareSemver(this.currentVersion, minSupportedAgentdVersion) < 0),
      app_store_url: this.buddyAppStoreUrl,
    };
  }

  async checkNow(): Promise<UpdateStatus> {
    this.status = {
      ...this.status,
      status: "checking",
      error: undefined,
    };

    try {
      const response = await this.fetchImpl(this.releasesUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "asynq-agentd",
        },
      });
      if (!response.ok) {
        throw new Error(`GitHub releases returned ${response.status}`);
      }

      const release = await response.json() as LatestReleaseResponse;
      const latestVersion = sanitizeVersion(release.tag_name);
      const checkedAt = nowIso();
      if (!latestVersion) {
        this.status = {
          ...this.status,
          checked_at: checkedAt,
          status: "failed",
          error: "Latest release version was missing",
        };
        return this.getStatus();
      }

      this.status = {
        current_version: this.currentVersion,
        latest_version: latestVersion,
        checked_at: checkedAt,
        status: compareSemver(latestVersion, this.currentVersion) > 0 ? "update_available" : "up_to_date",
        release_url: release.html_url,
        release_notes: truncateReleaseNotes(release.body),
        error: undefined,
        install_supported: true,
      };
      return this.getStatus();
    } catch (error) {
      this.status = {
        ...this.status,
        checked_at: nowIso(),
        status: "failed",
        error: error instanceof Error ? error.message : "Update check failed",
      };
      return this.getStatus();
    }
  }

  async installUpdate(): Promise<UpdateStatus> {
    if (!this.status.latest_version || compareSemver(this.status.latest_version, this.currentVersion) <= 0) {
      await this.checkNow();
    }

    if (!this.status.latest_version || compareSemver(this.status.latest_version, this.currentVersion) <= 0) {
      return this.getStatus();
    }

    this.status = {
      ...this.status,
      status: "installing",
      error: undefined,
    };

    try {
      await this.runCommand(this.installCommand);
      this.status = {
        ...this.status,
        status: "restarting",
      };
      await this.runCommand(this.restartCommand);
      return this.getStatus();
    } catch (error) {
      this.status = {
        ...this.status,
        status: "failed",
        error: error instanceof Error ? error.message : "Install failed",
      };
      return this.getStatus();
    }
  }
}
