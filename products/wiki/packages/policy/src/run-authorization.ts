import { OPENWIKI_RUN_TYPES, type RunType } from "@openwiki/core";
import type { OpenWikiOperation } from "./types.ts";
import { uniqueOperations } from "./operations.ts";

export interface RunAuthorizationSpec {
  runType: RunType;
  operations: OpenWikiOperation[];
  requiresInboxItem?: boolean;
  httpAllowed?: boolean;
  mcpAllowed?: boolean;
}

const RUN_AUTHORIZATION_SPECS: Record<RunType, RunAuthorizationSpec> = {
  "index.rebuild": { runType: "index.rebuild", operations: ["wiki.run_job", "wiki.admin"] },
  "static.export": { runType: "static.export", operations: ["wiki.run_job", "wiki.publish"] },
  lint: { runType: "lint", operations: ["wiki.run_job", "wiki.run_lint"] },
  "source.fetch": { runType: "source.fetch", operations: ["wiki.run_job", "wiki.fetch_source"] },
  "git.sync": { runType: "git.sync", operations: ["wiki.run_job", "wiki.sync_now"] },
  "backup.create": { runType: "backup.create", operations: ["wiki.run_job", "wiki.admin"] },
  "inbox.process": { runType: "inbox.process", operations: ["wiki.run_job", "wiki.inbox_process"], requiresInboxItem: true },
  "inbox.watch": { runType: "inbox.watch", operations: ["wiki.run_job", "wiki.admin"], httpAllowed: false, mcpAllowed: false },
  "inbox.reconcile": { runType: "inbox.reconcile", operations: ["wiki.run_job", "wiki.inbox_read"] },
  "inbox.sync_after_process": { runType: "inbox.sync_after_process", operations: ["wiki.run_job", "wiki.sync_now"] },
  "dream.run": { runType: "dream.run", operations: ["wiki.dream_run"], httpAllowed: false, mcpAllowed: false },
};

const RUN_AUTHORIZATION_SPEC_VALUES = Object.values(RUN_AUTHORIZATION_SPECS);
const MISSING_RUN_AUTHORIZATION_SPECS = OPENWIKI_RUN_TYPES.filter((runType) => RUN_AUTHORIZATION_SPECS[runType] === undefined);
if (MISSING_RUN_AUTHORIZATION_SPECS.length > 0) {
  throw new Error(`Missing OpenWiki run authorization specs: ${MISSING_RUN_AUTHORIZATION_SPECS.join(", ")}`);
}

export function runJobAuthorizationSpec(runType: string): RunAuthorizationSpec | undefined {
  return RUN_AUTHORIZATION_SPEC_VALUES.find((candidate) => candidate.runType === runType);
}

export function runJobAuthorizationOperations(runType: string): OpenWikiOperation[] {
  return uniqueOperations(runJobAuthorizationSpec(runType)?.operations ?? []);
}

export function runJobAllowedFromHttp(runType: string): boolean {
  const spec = runJobAuthorizationSpec(runType);
  return spec !== undefined && spec.httpAllowed !== false;
}

export function runJobAllowedFromMcp(runType: string): boolean {
  const spec = runJobAuthorizationSpec(runType);
  return spec !== undefined && spec.mcpAllowed !== false;
}

export function runJobRequiresInboxItem(runType: string): boolean {
  return RUN_AUTHORIZATION_SPEC_VALUES.some((candidate) => candidate.runType === runType && candidate.requiresInboxItem === true);
}

export function inboxProcessRunInputId(input: Record<string, unknown> | undefined): string | undefined {
  const value = input?.id ?? input?.inbox_item_id;
  return typeof value === "string" && value.trim() ? value : undefined;
}
