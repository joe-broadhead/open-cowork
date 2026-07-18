export const OPENWIKI_PROTOCOL_VERSION = "0.1" as const;
export const OPENWIKI_REPO_FORMAT = "openwiki-repo-v0" as const;
export const OPENWIKI_VERSION = "0.0.0" as const;
export const OPENWIKI_MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const OPENWIKI_MCP_TOOL_OUTPUT_DEFAULT_MAX_BYTES = 256 * 1024;

export type OpenWikiKind =
  | "page"
  | "source"
  | "fragment"
  | "claim"
  | "fact"
  | "take"
  | "inbox"
  | "proposal"
  | "comment"
  | "decision"
  | "commit"
  | "actor"
  | "run"
  | "organization"
  | "tenant"
  | "workspace"
  | "workspace_repo"
  | "event"
  | "policy"
  | "edge"
  | "topic"
  | "section";
