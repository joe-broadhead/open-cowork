import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENWIKI_ERROR_MODEL,
  OpenWikiConflictError,
  OpenWikiError,
  OpenWikiNotFoundError,
  OpenWikiPolicyDeniedError,
  OpenWikiRuntimeBusyError,
  OpenWikiUpstreamSourceFetchError,
  OpenWikiValidationError,
  openWikiCliExitCodeForError,
  openWikiErrorCategoryForCode,
  openWikiHttpStatusForCode,
  openWikiHttpStatusForError,
  openWikiMcpJsonRpcCodeForError,
} from "@openwiki/core";
import { AuthorizationError } from "@openwiki/policy";
import { PostgresWriteLeaseBusyError } from "@openwiki/postgres-runtime";
import { OpenWikiWriteInProgressError } from "@openwiki/workflows";

test("OpenWiki error model has explicit adapter mappings", () => {
  const categories = new Set(OPENWIKI_ERROR_MODEL.map((entry) => entry.category));
  assert.equal(categories.size, OPENWIKI_ERROR_MODEL.length);

  const cases = [
    { error: new OpenWikiNotFoundError("missing"), category: "not_found", http: 404, mcp: -32004 },
    { error: new OpenWikiValidationError("invalid"), category: "validation", http: 400, mcp: -32602 },
    { error: new OpenWikiPolicyDeniedError("denied"), category: "policy_denied", http: 403, mcp: -32001 },
    { error: new OpenWikiConflictError("conflict"), category: "conflict", http: 409, mcp: -32009 },
    { error: new OpenWikiRuntimeBusyError("busy"), category: "write_in_progress", http: 423, mcp: -32023 },
    { error: new OpenWikiUpstreamSourceFetchError("upstream"), category: "upstream_source_fetch", http: 502, mcp: -32052 },
  ] as const;

  for (const { error, category, http, mcp } of cases) {
    assert.equal(error.category, category);
    assert.equal(openWikiHttpStatusForError(error), http);
    assert.equal(openWikiCliExitCodeForError(error), 1);
    assert.equal(openWikiMcpJsonRpcCodeForError(error), mcp);
  }
});

test("legacy OpenWiki error codes map through the shared model", () => {
  assert.equal(openWikiErrorCategoryForCode("bad_request"), "validation");
  assert.equal(openWikiErrorCategoryForCode("invalid_git_revision"), "validation");
  assert.equal(openWikiErrorCategoryForCode("forbidden"), "policy_denied");
  assert.equal(openWikiErrorCategoryForCode("runtime_busy"), "write_in_progress");

  assert.equal(openWikiHttpStatusForCode("bad_request"), 400);
  assert.equal(openWikiHttpStatusForCode("payload_too_large"), 413);
  assert.equal(openWikiHttpStatusForCode("runtime_busy"), 423);
  assert.equal(openWikiHttpStatusForError(new OpenWikiError("runtime_busy", "busy")), 423);
});

test("policy authorization errors use the shared policy-denied category", () => {
  const error = new AuthorizationError({
    allowed: false,
    operation: "wiki.read_page",
    required_scopes: ["wiki:read"],
    granted_scopes: [],
    missing_scopes: ["wiki:read"],
  });

  assert.equal(error.category, "policy_denied");
  assert.equal(openWikiHttpStatusForError(error), 403);
  assert.equal(openWikiMcpJsonRpcCodeForError(error), -32001);
});

test("write coordination errors use the shared write-in-progress mapping", () => {
  const localError = new OpenWikiWriteInProgressError({
    backend: "local",
    lock_name: "git-writes",
    actor_id: "actor:user:alice",
    operation: "wiki.apply_proposal",
    started_at: "2026-05-29T00:00:00.000Z",
    heartbeat_at: "2026-05-29T00:00:01.000Z",
    expires_at: "2026-05-29T00:00:30.000Z",
    metadata: {},
  });
  const postgresError = new PostgresWriteLeaseBusyError({
    workspace_id: "wiki",
    lock_name: "git-writes",
    actor_id: "actor:user:alice",
    operation: "wiki.apply_proposal",
    started_at: "2026-05-29T00:00:00.000Z",
    heartbeat_at: "2026-05-29T00:00:01.000Z",
    expires_at: "2026-05-29T00:00:30.000Z",
    metadata: {},
  });

  for (const error of [localError, postgresError]) {
    assert.equal(error.category, "write_in_progress");
    assert.equal(openWikiHttpStatusForError(error), 423);
    assert.equal(openWikiMcpJsonRpcCodeForError(error), -32023);
  }
});
