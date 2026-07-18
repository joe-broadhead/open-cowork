export type OpenWikiErrorCode =
  | "not_found"
  | "validation"
  | "policy_denied"
  | "upstream_source_fetch"
  | "internal"
  | "bad_request"
  | "conflict"
  | "forbidden"
  | "payload_too_large"
  | "runtime_busy"
  | "invalid_git_revision";

export type OpenWikiErrorCategory =
  | "not_found"
  | "validation"
  | "policy_denied"
  | "conflict"
  | "write_in_progress"
  | "upstream_source_fetch"
  | "internal";

export interface OpenWikiErrorModelEntry {
  category: OpenWikiErrorCategory;
  code: OpenWikiErrorCode;
  http_status: number;
  cli_exit_code: number;
  mcp_jsonrpc_code: number;
  retryable: boolean;
  description: string;
}

/** Shared error contract used by HTTP, CLI, MCP, docs, and operational tests. */
export const OPENWIKI_ERROR_MODEL: readonly OpenWikiErrorModelEntry[] = [
  {
    category: "not_found",
    code: "not_found",
    http_status: 404,
    cli_exit_code: 1,
    mcp_jsonrpc_code: -32004,
    retryable: false,
    description: "The requested page, source, proposal, run, workspace, object, or route does not exist or is not visible to the caller.",
  },
  {
    category: "validation",
    code: "validation",
    http_status: 400,
    cli_exit_code: 1,
    mcp_jsonrpc_code: -32602,
    retryable: false,
    description: "The request shape, flag value, JSON body, Git revision, schema payload, or path input is invalid.",
  },
  {
    category: "policy_denied",
    code: "policy_denied",
    http_status: 403,
    cli_exit_code: 1,
    mcp_jsonrpc_code: -32001,
    retryable: false,
    description: "The actor, role, token, principal, MCP tool mode, or Space grant does not allow the requested operation.",
  },
  {
    category: "conflict",
    code: "conflict",
    http_status: 409,
    cli_exit_code: 1,
    mcp_jsonrpc_code: -32009,
    retryable: false,
    description: "The request conflicts with current repository state, such as stale proposal base commits or unexpected run/proposal state.",
  },
  {
    category: "write_in_progress",
    code: "runtime_busy",
    http_status: 423,
    cli_exit_code: 1,
    mcp_jsonrpc_code: -32023,
    retryable: true,
    description: "Another writer holds the local or Postgres write lease. Retry after the active writer completes or the lease expires.",
  },
  {
    category: "upstream_source_fetch",
    code: "upstream_source_fetch",
    http_status: 502,
    cli_exit_code: 1,
    mcp_jsonrpc_code: -32052,
    retryable: true,
    description: "A configured source connector, object store, Git remote, or upstream HTTP fetch failed after OpenWiki accepted the request.",
  },
  {
    category: "internal",
    code: "internal",
    http_status: 500,
    cli_exit_code: 1,
    mcp_jsonrpc_code: -32603,
    retryable: false,
    description: "An unexpected OpenWiki bug, environment failure, or unclassified adapter failure occurred.",
  },
];

/** Base class for OpenWiki errors that need stable machine-readable mapping. */
export class OpenWikiError extends Error {
  readonly code: OpenWikiErrorCode;
  readonly status: number;
  readonly category: OpenWikiErrorCategory;

  constructor(code: OpenWikiErrorCode, message: string, status = openWikiHttpStatusForCode(code), category = openWikiErrorCategoryForCode(code)) {
    super(message);
    this.name = "OpenWikiError";
    this.code = code;
    this.status = status;
    this.category = category;
  }
}

/** Raised when a requested visible OpenWiki resource cannot be found. */
export class OpenWikiNotFoundError extends OpenWikiError {
  constructor(message: string) {
    super("not_found", message, 404, "not_found");
    this.name = "OpenWikiNotFoundError";
  }
}

/** Raised when request, record, or configuration input is invalid. */
export class OpenWikiValidationError extends OpenWikiError {
  constructor(message: string) {
    super("validation", message, 400, "validation");
    this.name = "OpenWikiValidationError";
  }
}

/** Raised when policy, token, role, or scope checks deny an operation. */
export class OpenWikiPolicyDeniedError extends OpenWikiError {
  constructor(message: string) {
    super("policy_denied", message, 403, "policy_denied");
    this.name = "OpenWikiPolicyDeniedError";
  }
}

/** Raised when a write conflicts with current repository or runtime state. */
export class OpenWikiConflictError extends OpenWikiError {
  constructor(message: string) {
    super("conflict", message, 409, "conflict");
    this.name = "OpenWikiConflictError";
  }
}

/** Raised when the local or hosted write coordinator cannot grant a lease. */
export class OpenWikiRuntimeBusyError extends OpenWikiError {
  constructor(message: string) {
    super("runtime_busy", message, 423, "write_in_progress");
    this.name = "OpenWikiRuntimeBusyError";
  }
}

/** Raised when OpenWiki accepted a request but an upstream dependency failed. */
export class OpenWikiUpstreamSourceFetchError extends OpenWikiError {
  constructor(message: string) {
    super("upstream_source_fetch", message, 502, "upstream_source_fetch");
    this.name = "OpenWikiUpstreamSourceFetchError";
  }
}

/** Raised for unclassified internal failures that should map consistently. */
export class OpenWikiInternalError extends OpenWikiError {
  constructor(message: string) {
    super("internal", message, 500, "internal");
    this.name = "OpenWikiInternalError";
  }
}

/** Return the canonical model row for an error category. */
export function openWikiErrorModelEntry(category: OpenWikiErrorCategory): OpenWikiErrorModelEntry {
  return OPENWIKI_ERROR_MODEL.find((entry) => entry.category === category) ?? (OPENWIKI_ERROR_MODEL[OPENWIKI_ERROR_MODEL.length - 1] as OpenWikiErrorModelEntry);
}

/** Map a legacy or canonical error code to the closest stable category. */
export function openWikiErrorCategoryForCode(code: OpenWikiErrorCode): OpenWikiErrorCategory {
  switch (code) {
    case "not_found":
      return "not_found";
    case "validation":
    case "bad_request":
    case "payload_too_large":
    case "invalid_git_revision":
      return "validation";
    case "policy_denied":
    case "forbidden":
      return "policy_denied";
    case "conflict":
      return "conflict";
    case "runtime_busy":
      return "write_in_progress";
    case "upstream_source_fetch":
      return "upstream_source_fetch";
    case "internal":
      return "internal";
  }
}

/** Map an OpenWiki error code to its canonical HTTP status. */
export function openWikiHttpStatusForCode(code: OpenWikiErrorCode): number {
  if (code === "bad_request" || code === "invalid_git_revision") {
    return 400;
  }
  if (code === "forbidden") {
    return 403;
  }
  if (code === "payload_too_large") {
    return 413;
  }
  return openWikiErrorModelEntry(openWikiErrorCategoryForCode(code)).http_status;
}

/** Return the best-effort HTTP status for any thrown value. */
export function openWikiHttpStatusForError(error: unknown): number {
  return error instanceof OpenWikiError ? error.status : 500;
}

/** Return the best-effort CLI exit code for any thrown value. */
export function openWikiCliExitCodeForError(error: unknown): number {
  return error instanceof OpenWikiError ? openWikiErrorModelEntry(error.category).cli_exit_code : 1;
}

/** Return the best-effort MCP JSON-RPC error code for any thrown value. */
export function openWikiMcpJsonRpcCodeForError(error: unknown): number {
  return error instanceof OpenWikiError ? openWikiErrorModelEntry(error.category).mcp_jsonrpc_code : -32603;
}
