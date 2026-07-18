import { OpenWikiError } from "@openwiki/core";
import type { AuthorizationResult } from "./types.ts";

/** Error raised when an actor lacks the scopes or role required for a wiki operation. */
export class AuthorizationError extends OpenWikiError {
  readonly statusCode = 403;
  readonly result: AuthorizationResult;

  constructor(result: AuthorizationResult) {
    const message = result.denied_by_bounds === true
      ? `OpenWiki operation '${result.operation}' is outside this credential's policy bounds`
      : `OpenWiki operation '${result.operation}' requires scope${result.missing_scopes.length === 1 ? "" : "s"} ${result.missing_scopes.join(", ")}`;
    super(
      "forbidden",
      message,
      403,
    );
    this.name = "AuthorizationError";
    this.result = result;
  }
}
