import type { OpenWikiConfig } from "./config.ts";

const ALLOWED_OPENWIKI_GIT_REMOTE_SCHEMES = new Set(["https", "ssh"]);
const OPENWIKI_SCP_STYLE_GIT_REMOTE_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:][^\s]*$/u;

export interface OpenWikiGitRemoteUrlOptions {
  allowLocalRemotes?: boolean;
}

export function validateOpenWikiGitRemoteUrl(value: string, options: OpenWikiGitRemoteUrlOptions = {}): void {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Git remote URL must not be empty");
  }
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error("Git remote URL must not contain control characters");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(trimmed)) {
    throw new Error('Git remote URL transport helpers (e.g. "ext::") are not allowed');
  }

  let url: URL | undefined;
  try {
    url = new URL(trimmed);
  } catch {
    url = undefined;
  }

  if (url) {
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    if (scheme === "http" && options.allowLocalRemotes === true && isLoopbackGitRemoteHostname(url.hostname)) {
      if (url.username || url.password) {
        throw new Error("Git remote URL must not include credentials; use credential_ref or deployment Git auth");
      }
      return;
    }
    if (!ALLOWED_OPENWIKI_GIT_REMOTE_SCHEMES.has(scheme)) {
      throw new Error(`Git remote URL scheme "${scheme}" is not allowed; use https or ssh`);
    }
    if ((scheme === "https" && (url.username || url.password)) || (scheme === "ssh" && url.password)) {
      throw new Error("Git remote URL must not include credentials; use credential_ref or deployment Git auth");
    }
    if (!url.hostname) {
      throw new Error("Git remote URL must include a host");
    }
    return;
  }

  if (OPENWIKI_SCP_STYLE_GIT_REMOTE_PATTERN.test(trimmed)) {
    return;
  }

  if (options.allowLocalRemotes === true && looksLikeLocalGitRemotePath(trimmed)) {
    return;
  }

  throw new Error("Git remote URL must use https, ssh, or scp-like SSH syntax");
}

export function redactOpenWikiGitRemoteUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.toString();
  } catch {
    return value.replace(/(https?:\/\/)[^/@]+@/i, "$1***@");
  }
}

export function redactOpenWikiWorkspaceConfig(config: OpenWikiConfig): OpenWikiConfig {
  const git = config.runtime?.git;
  if (git?.remote_url === undefined) {
    return config;
  }
  return {
    ...config,
    runtime: {
      ...config.runtime,
      git: {
        ...git,
        remote_url: redactOpenWikiGitRemoteUrl(git.remote_url),
      },
    },
  };
}

function isLoopbackGitRemoteHostname(value: string): boolean {
  const hostname = value.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function looksLikeLocalGitRemotePath(value: string): boolean {
  if (OPENWIKI_SCP_STYLE_GIT_REMOTE_PATTERN.test(value)) {
    return false;
  }
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value.endsWith(".git")
  );
}
