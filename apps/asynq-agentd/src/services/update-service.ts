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

type RunCommandOptions = {
  env?: Record<string, string>;
  timeoutMs?: number;
};

type RunCommand = (command: string, options?: RunCommandOptions) => Promise<void>;

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

type PullRequestResponse = {
  body?: string;
  html_url?: string;
};

function truncateCommandOutput(output: string, maxLength = 2000): string {
  const normalized = output.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(normalized.length - maxLength);
}

function defaultRunCommand(command: string, options?: RunCommandOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      env: {
        ...process.env,
        ...options?.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outputChunks: Buffer[] = [];
    const timeoutMs = options?.timeoutMs ?? Number(process.env.ASYNQ_AGENTD_UPDATE_COMMAND_TIMEOUT_MS ?? 15 * 60 * 1000);
    let didTimeout = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        didTimeout = true;
        child.kill("SIGTERM");
      }, timeoutMs)
      : undefined;

    const captureOutput = (chunk: Buffer | string) => {
      outputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let totalLength = outputChunks.reduce((total, item) => total + item.length, 0);
      while (totalLength > 16_384 && outputChunks.length > 1) {
        const removed = outputChunks.shift();
        totalLength -= removed?.length ?? 0;
      }
    };

    child.stdout?.on("data", captureOutput);
    child.stderr?.on("data", captureOutput);

    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("exit", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      const output = truncateCommandOutput(Buffer.concat(outputChunks).toString("utf8"));
      if (code === 0) {
        resolve();
        return;
      }

      const reason = didTimeout
        ? `Command timed out after ${timeoutMs}ms`
        : `Command failed with exit code ${code ?? "unknown"}`;
      reject(new Error(output ? `${reason}: ${output}` : reason));
    });
  });
}

function truncateReleaseNotes(body: string | undefined, maxLength = 1600): string | undefined {
  if (!body) {
    return undefined;
  }

  const normalized = body
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildReleaseRef(version: string | undefined): string | undefined {
  const sanitized = sanitizeVersion(version);
  if (!sanitized) {
    return undefined;
  }

  // Keep this strict to avoid shell injection when used in command env assignment.
  if (!/^[0-9]+(?:\.[0-9]+)*(?:[-+][0-9A-Za-z.-]+)?$/.test(sanitized)) {
    return undefined;
  }

  return `v${sanitized}`;
}

type PullRequestLink = {
  owner: string;
  repo: string;
  number: string;
  url: string;
};

function extractPullRequestLinks(text: string | undefined): PullRequestLink[] {
  if (!text) {
    return [];
  }

  const links: PullRequestLink[] = [];
  const pattern = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g;
  const seen = new Set<string>();

  let match = pattern.exec(text);
  while (match) {
    const owner = match[1];
    const repo = match[2];
    const number = match[3];
    const url = `https://github.com/${owner}/${repo}/pull/${number}`;
    if (!seen.has(url)) {
      seen.add(url);
      links.push({
        owner,
        repo,
        number,
        url,
      });
    }
    match = pattern.exec(text);
  }

  return links;
}

function parseStructuredReleaseNotes(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const versionMatch = text.match(/asynq-agentd@[^\s)]+/i);
  if (!versionMatch) {
    return undefined;
  }

  const lines = text.split("\n").map((line) => line.trimEnd());
  const sections: Record<"Major" | "Minor" | "Patch", string[]> = {
    Major: [],
    Minor: [],
    Patch: [],
  };
  let currentSection: "Major" | "Minor" | "Patch" | undefined;
  let inScope = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!inScope && line.toLowerCase().includes(versionMatch[0].toLowerCase())) {
      inScope = true;
      continue;
    }

    if (!inScope) {
      continue;
    }

    const heading = line.match(/^(?:#{1,6}\s*)?(Major|Minor|Patch)\s+Changes(?:\s*:)?\s*$/i)
      ?? line.match(/^\*\*(Major|Minor|Patch)\s+Changes\*\*(?:\s*:)?\s*$/i);
    if (heading) {
      const section = heading[1];
      currentSection = (section[0].toUpperCase() + section.slice(1).toLowerCase()) as "Major" | "Minor" | "Patch";
      continue;
    }

    if (/^(?:#{1,6}\s+|##?\s+full changelog|full changelog)/i.test(line)) {
      currentSection = undefined;
      continue;
    }

    if (!currentSection) {
      continue;
    }

    if (!line) {
      continue;
    }

    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      sections[currentSection].push(line);
      continue;
    }

    sections[currentSection].push(`- ${line}`);
  }

  const hasStructuredContent = sections.Major.length > 0 || sections.Minor.length > 0 || sections.Patch.length > 0;
  if (!hasStructuredContent) {
    return undefined;
  }

  const output: string[] = [versionMatch[0]];
  if (sections.Major.length > 0) {
    output.push("", "Major Changes", ...sections.Major);
  }
  if (sections.Minor.length > 0) {
    output.push("", "Minor Changes", ...sections.Minor);
  }
  if (sections.Patch.length > 0) {
    output.push("", "Patch Changes", ...sections.Patch);
  }

  return output.join("\n").trim();
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

  startInstallUpdate(): UpdateStatus {
    if (this.status.status === "installing" || this.status.status === "restarting") {
      return this.getStatus();
    }

    this.status = {
      ...this.status,
      status: "installing",
      error: undefined,
    };

    queueMicrotask(() => {
      void this.installUpdate();
    });
    return this.getStatus();
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

      const structuredFromRelease = parseStructuredReleaseNotes(release.body);
      const structuredFromPullRequests = structuredFromRelease
        ? undefined
        : await this.fetchStructuredNotesFromPullRequests(release);

      this.status = {
        current_version: this.currentVersion,
        latest_version: latestVersion,
        checked_at: checkedAt,
        status: compareSemver(latestVersion, this.currentVersion) > 0 ? "update_available" : "up_to_date",
        release_url: release.html_url,
        release_notes: truncateReleaseNotes(structuredFromRelease ?? structuredFromPullRequests ?? release.body),
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
      const releaseRef = buildReleaseRef(this.status.latest_version);
      await this.runCommand(this.installCommand, releaseRef ? { env: { ASYNQ_AGENTD_REF: releaseRef } } : undefined);
      this.status = {
        ...this.status,
        status: "restarting",
      };
      try {
        await this.runCommand(this.restartCommand);
      } catch {
        // Best-effort recovery for environments where restart is unsupported but start works.
        await this.runCommand("asynq-agentctl start");
      }
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

  private async fetchStructuredNotesFromPullRequests(release: LatestReleaseResponse): Promise<string | undefined> {
    const sources = [release.body, release.html_url].filter(Boolean).join("\n");
    const links = extractPullRequestLinks(sources);
    if (links.length === 0) {
      return undefined;
    }

    const blocks: string[] = [];
    for (const link of links) {
      try {
        const response = await this.fetchImpl(`https://api.github.com/repos/${link.owner}/${link.repo}/pulls/${link.number}`, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "asynq-agentd",
          },
        });
        if (!response.ok) {
          continue;
        }

        const pullRequest = await response.json() as PullRequestResponse;
        const parsed = parseStructuredReleaseNotes(pullRequest.body);
        if (!parsed) {
          continue;
        }

        blocks.push(`${parsed}\n\nSource: ${pullRequest.html_url ?? link.url}`);
      } catch {
        continue;
      }
    }

    return blocks.length > 0 ? blocks.join("\n\n") : undefined;
  }
}
