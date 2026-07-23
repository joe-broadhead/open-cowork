/**
 * Pure / near-pure helpers peeled from tool-router.ts to keep the router under
 * the OpenWiki module-size hard budget (800 LOC).
 */
import { loadRepository, readProposalDetailWithOptions } from "@openwiki/repo";
import { pathAllowedByContextBounds } from "@openwiki/policy";
import { redactOpenWikiRunRecord, type ProposalRecord, type RunRecord } from "@openwiki/core";
import type { McpPolicyContext } from "./types.ts";
import {
  optionalBooleanParam,
  optionalNumberParam,
  optionalStringArrayParam,
  optionalStringObjectProperty,
  optionalStringParam,
} from "./params.ts";
import {
  assertMcpPathAuthorized,
  DEFAULT_LOCAL_MCP_ACTOR_ID,
} from "./policy-adapter.ts";

export function dreamRunInputFromMcp(args: Record<string, unknown>): Record<string, unknown> {
  const phases = optionalStringArrayParam(args, "phases");
  const limit = optionalNumberParam(args, "limit");
  const timeoutMs = optionalNumberParam(args, "timeout_ms");
  const dryRun = optionalBooleanParam(args, "dry_run");
  const createProposals = optionalBooleanParam(args, "create_proposals");
  return {
    ...(phases === undefined ? {} : { phases }),
    ...(limit === undefined ? {} : { limit }),
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
    ...(dryRun === undefined ? {} : { dry_run: dryRun }),
    ...(createProposals === undefined ? {} : { create_proposals: createProposals }),
    ...optionalStringObjectProperty(args, "provider", "provider"),
    ...optionalStringObjectProperty(args, "schema_pack", "schema_pack"),
  };
}

export function mcpActorId(context: McpPolicyContext, args: Record<string, unknown>): string | undefined {
  const requestedActorId = optionalStringParam(args, "actor_id");
  if (context.actorId !== undefined && context.actorId !== DEFAULT_LOCAL_MCP_ACTOR_ID) {
    return context.actorId;
  }
  if (context.role !== undefined || (context.principals !== undefined && context.principals.length > 0)) {
    return "actor:user:local";
  }
  if (requestedActorId !== undefined) {
    return requestedActorId;
  }
  if (context.actorId !== undefined) {
    return context.actorId;
  }
  return undefined;
}

export async function assertMcpPathsAuthorized(
  root: string,
  operation: Parameters<typeof assertMcpPathAuthorized>[1],
  context: McpPolicyContext,
  paths: readonly string[],
): Promise<void> {
  for (const repoPath of paths) {
    await assertMcpPathAuthorized(root, operation, context, repoPath);
  }
}

export async function readProposalDetailForMcp(root: string, id: string, context: McpPolicyContext): Promise<unknown> {
  const repo = await loadRepository(root);
  const proposal = repo.proposals.find((candidate) => candidate.id === id || candidate.uri === id);
  return readProposalDetailWithOptions(root, id, {
    authorizePath(repoPath) {
      if (proposal !== undefined && !proposalArtifactBelongsToProposal(proposal, repoPath)) {
        throw new Error(`OpenWiki proposal artifact path is not bound to proposal ${proposal.id}: ${repoPath}`);
      }
      if (!pathAllowedByContextBounds(repo.policy, context, repoPath)) {
        throw new Error(`OpenWiki policy bounds do not allow proposal artifact path ${repoPath}`);
      }
    },
  });
}

export function proposalArtifactBelongsToProposal(proposal: ProposalRecord, repoPath: string): boolean {
  const stem = proposal.id.replace(/:/g, "_").replace(/-/g, "_");
  return (
    repoPath === `proposals/diffs/${stem}.diff` ||
    repoPath === `proposals/reports/${stem}.json` ||
    repoPath === `proposals/validation/${stem}.json` ||
    repoPath.startsWith(`proposals/snapshots/${stem}/`)
  );
}

export function redactRunJobResult<T extends { run: RunRecord }>(result: T, context: McpPolicyContext): T {
  return {
    ...result,
    run: redactRunForMcp(result.run, context),
  };
}

export function redactRunToolResponseForMcp(value: unknown, context: McpPolicyContext): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && "run" in value) {
    const record = value as { run?: unknown };
    if (isRunRecord(record.run)) {
      return {
        ...value,
        run: redactRunForMcp(record.run, context),
      };
    }
  }
  return value;
}

export function redactRunForMcp(run: RunRecord, context: McpPolicyContext): RunRecord {
  return redactOpenWikiRunRecord(run, { includeSensitiveOperationalMetadata: context.role === "admin" || context.scopes.includes("wiki:admin") });
}

export function isRunRecord(value: unknown): value is RunRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "run";
}
