export const AGENTD_VERSION = "0.4.0";
export const MIN_SUPPORTED_BUDDY_VERSION = "0.1.0";
export const DEFAULT_GITHUB_RELEASES_URL = "https://api.github.com/repos/asynq-org/asynq-agentd/releases/latest";
export const DEFAULT_INSTALL_COMMAND = "curl -fsSL https://agentd.asynq.org/install.sh | sh -s -- --reuse-config --non-interactive --skip-pairing";
export const DEFAULT_RESTART_COMMAND = "asynq-agentctl restart";

function normalize(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((segment) => {
      const match = segment.match(/^(\d+)/);
      return match ? Number(match[1]) : 0;
    });
}

export function compareSemver(left: string, right: string): number {
  const a = normalize(left);
  const b = normalize(right);
  const max = Math.max(a.length, b.length);

  for (let index = 0; index < max; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }

  return 0;
}

export function sanitizeVersion(version: string | undefined): string | undefined {
  if (!version) {
    return undefined;
  }

  const trimmed = version.trim();
  return trimmed.length > 0 ? trimmed.replace(/^v/i, "") : undefined;
}
