import { redactOpenWikiGitRemoteUrl, validateOpenWikiGitRemoteUrl } from "@openwiki/core";

const LOCAL_GIT_REMOTE_FLAG = "OPENWIKI_ALLOW_LOCAL_GIT_REMOTE";

export function validateGitRemoteName(value: string): void {
  if (!value.trim() || value.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("Git remote name must contain only letters, numbers, dots, underscores, or dashes");
  }
}

export function validateGitBranchName(value: string): void {
  if (
    !value.trim() ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    /[\s~^:?*[\]\\\x00-\x1F\x7F]/.test(value)
  ) {
    throw new Error("Git branch name contains unsupported characters");
  }
}

export function validateSafeGitRemoteUrl(value: string): void {
  try {
    validateOpenWikiGitRemoteUrl(value, { allowLocalRemotes: process.env[LOCAL_GIT_REMOTE_FLAG] === "1" });
  } catch (error) {
    if (error instanceof Error && error.message === "Git remote URL must use https, ssh, or scp-like SSH syntax") {
      throw new Error(
        `Git remote URL must use https, ssh, or scp-like SSH syntax; local filesystem remotes require ${LOCAL_GIT_REMOTE_FLAG}=1`,
      );
    }
    throw error;
  }
}

export function redactRemoteUrl(value: string): string {
  return redactOpenWikiGitRemoteUrl(value);
}

export function sanitizeGitOutput(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => redactRemoteUrl(line))
    .join("\n")
    .trim();
}
