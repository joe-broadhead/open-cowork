import {
  assertPathAuthorized,
  assertReviewAuthorized,
  authorizeOperation,
  canReadInboxItemRecord,
  canReadRecordId,
  filterSearchResponseByVisibility,
  mcpToolOperationsForMode,
  mergePolicyBounds,
  parseScopes,
  resolveServiceAccountToken,
  scopesForMcpToolMode,
  scopesForRole,
  type OpenWikiOperation,
  type OpenWikiRole,
  type OpenWikiScope,
  type PolicyBounds,
} from "@openwiki/policy";
import { loadRepository } from "@openwiki/repo";
import { type ProposalRecord, type SearchResponse } from "@openwiki/core";
import { inboxProcessAuthorizationPath } from "@openwiki/workflows";
import { TOOL_DEFINITIONS } from "./tool-definitions.ts";
import { optionalStringParam } from "./params.ts";
import type { McpPolicyContext, McpServerOptions, McpToolMode } from "./types.ts";

export const DEFAULT_LOCAL_MCP_ACTOR_ID = "actor:agent:openwiki-mcp";

export function toolsForMode(toolMode: McpToolMode): typeof TOOL_DEFINITIONS {
  const allowedOperations = new Set<string>(mcpToolOperationsForMode(toolMode));
  return TOOL_DEFINITIONS.filter((tool) => allowedOperations.has(tool.name));
}

export async function toolsForPolicy(
  root: string,
  options: Pick<McpServerOptions, "toolMode" | "actorId" | "role" | "scopes" | "token" | "principals" | "bounds">,
): Promise<typeof TOOL_DEFINITIONS> {
  const context = await policyContextForMcp(root, options);
  const boundOnlyContext = { ...context, scopes: ["wiki:admin" as const] };
  return toolsForMode(options.toolMode ?? "read").filter((tool) => authorizeOperation(openWikiOperation(tool.name), boundOnlyContext).allowed);
}

export function toolAllowed(name: string, toolMode: McpToolMode): boolean {
  return toolsForMode(toolMode).some((tool) => tool.name === name);
}

export function openWikiOperation(name: string): OpenWikiOperation {
  if (
    name === "wiki.search" ||
    name === "wiki.recall" ||
    name === "wiki.ask" ||
    name === "wiki.think" ||
    name === "wiki.read_page" ||
    name === "wiki.read_source" ||
    name === "wiki.read_claim" ||
    name === "wiki.list_facts" ||
    name === "wiki.read_fact" ||
    name === "wiki.list_takes" ||
    name === "wiki.read_take" ||
    name === "wiki.takes_scorecard" ||
    name === "wiki.find_trajectory" ||
    name === "wiki.list_proposals" ||
    name === "wiki.read_proposal" ||
    name === "wiki.read_proposal_detail" ||
    name === "wiki.read_decision" ||
    name === "wiki.trace_claim" ||
    name === "wiki.get_history" ||
    name === "wiki.diff_versions" ||
    name === "wiki.list_recent_changes" ||
    name === "wiki.git_status" ||
    name === "wiki.git_pull" ||
    name === "wiki.git_push" ||
    name === "wiki.sync_now" ||
    name === "wiki.list_events" ||
    name === "wiki.list_runs" ||
    name === "wiki.dream_status" ||
    name === "wiki.dream_run" ||
    name === "wiki.list_topics" ||
    name === "wiki.list_open_questions" ||
    name === "wiki.inbox_list" ||
    name === "wiki.inbox_read" ||
    name === "wiki.inbox_submit" ||
    name === "wiki.inbox_process" ||
    name === "wiki.inbox_ignore" ||
    name === "wiki.inbox_retry" ||
    name === "wiki.detect_governance" ||
    name === "wiki.graph_neighbors" ||
    name === "wiki.graph_backlinks" ||
    name === "wiki.graph_related" ||
    name === "wiki.graph_path" ||
    name === "wiki.graph_orphans" ||
    name === "wiki.graph_stale" ||
    name === "wiki.graph_report" ||
    name === "wiki.read_policy" ||
    name === "wiki.list_workspaces" ||
    name === "wiki.connect_workspace" ||
    name === "wiki.propose_policy" ||
    name === "wiki.propose_section_policy" ||
    name === "wiki.propose_edit" ||
    name === "wiki.propose_synthesis" ||
    name === "wiki.propose_fact" ||
    name === "wiki.propose_take" ||
    name === "wiki.resolve_take" ||
    name === "wiki.forget_fact" ||
    name === "wiki.create_synthesis" ||
    name === "wiki.propose_source" ||
    name === "wiki.comment_on_proposal" ||
    name === "wiki.ingest_source" ||
    name === "wiki.fetch_source" ||
    name === "wiki.review_proposal" ||
    name === "wiki.close_proposal" ||
    name === "wiki.apply_proposal" ||
    name === "wiki.run_job" ||
    name === "wiki.run_lint" ||
    name === "wiki.commit_changes" ||
    name === "wiki.publish"
  ) {
    return name;
  }
  throw new Error(`Unsupported OpenWiki operation: ${name}`);
}

export async function policyContextForMcp(
  root: string,
  options: Pick<McpServerOptions, "toolMode" | "actorId" | "role" | "scopes" | "token" | "principals" | "bounds">,
): Promise<McpPolicyContext> {
  const parsedTokenScopes = parseScopes(options.token);
  if (options.token && parsedTokenScopes.length === 0) {
    const repo = await loadRepository(root);
    const serviceAccount = resolveServiceAccountToken(repo.config, options.token);
    if (serviceAccount) {
      return {
        actorId: serviceAccount.actorId,
        scopes: serviceAccount.scopes,
        ...(serviceAccount.role === undefined ? {} : { role: serviceAccount.role }),
        ...optionalMcpPrincipals([...((serviceAccount.principals) ?? []), ...((options.principals) ?? [])]),
        ...optionalMcpBounds(mergePolicyBounds(serviceAccount.bounds, options.bounds)),
      };
    }
  }

  if (options.scopes !== undefined || options.role !== undefined || parsedTokenScopes.length > 0) {
    const roleScopes = options.role === undefined ? [] : scopesForRole(options.role);
    return {
      ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.principals === undefined ? {} : { principals: options.principals }),
      ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
      scopes: [...roleScopes, ...parsedTokenScopes, ...(options.scopes ?? [])],
    };
  }

  return {
    ...(options.actorId === undefined && (options.toolMode ?? "read") === "read" ? {} : { actorId: options.actorId ?? DEFAULT_LOCAL_MCP_ACTOR_ID }),
    ...(options.principals === undefined ? {} : { principals: options.principals }),
    ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
    scopes: scopesForMcpToolMode(options.toolMode ?? "read"),
  };
}

function optionalMcpBounds(bounds: PolicyBounds | undefined): { bounds?: PolicyBounds } {
  return bounds === undefined ? {} : { bounds };
}

export function optionalGraphDirectionParam(args: Record<string, unknown>, name: string): "in" | "out" | "both" | undefined {
  const value = optionalStringParam(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (value === "in" || value === "out" || value === "both") {
    return value;
  }
  throw new Error("Expected " + name + " to be in, out, or both");
}

function optionalMcpPrincipals(principals: string[]): { principals?: string[] } {
  const unique = principals.filter((principal, index, values) => principal.trim().length > 0 && values.indexOf(principal) === index);
  return unique.length === 0 ? {} : { principals: unique };
}

export async function filterSearchResponseForMcp(
  root: string,
  context: { actorId?: string; scopes: OpenWikiScope[]; role?: OpenWikiRole; principals?: string[] },
  response: SearchResponse,
): Promise<SearchResponse> {
  const repo = await loadRepository(root);
  return filterSearchResponseByVisibility(repo, context, response);
}

export async function assertMcpVisibleRecord(
  root: string,
  context: { actorId?: string; scopes: OpenWikiScope[]; role?: OpenWikiRole; principals?: string[] },
  id: string,
): Promise<void> {
  const repo = await loadRepository(root);
  if (!canReadRecordId(repo, context, id)) {
    throw new Error(`OpenWiki record is not visible to this actor: ${id}`);
  }
}

export async function assertMcpInboxActionAuthorized(
  root: string,
  operation: "wiki.inbox_process" | "wiki.inbox_ignore" | "wiki.inbox_retry",
  context: { actorId?: string; scopes: OpenWikiScope[]; role?: OpenWikiRole; principals?: string[] },
  id: string,
): Promise<void> {
  const repo = await loadRepository(root);
  const item = repo.inbox.find((candidate) => candidate.id === id || candidate.uri === id);
  if (item === undefined || !canReadInboxItemRecord(repo, context, item)) {
    throw new Error(`OpenWiki record is not visible to this actor: ${id}`);
  }
  assertPathAuthorized(operation, context, repo.policy, inboxProcessAuthorizationPath(item, repo.policy), "maintainer");
}

export async function assertMcpInboxProcessAuthorized(
  root: string,
  context: { actorId?: string; scopes: OpenWikiScope[]; role?: OpenWikiRole; principals?: string[] },
  id: string,
): Promise<void> {
  await assertMcpInboxActionAuthorized(root, "wiki.inbox_process", context, id);
}

export async function assertMcpPathAuthorized(
  root: string,
  operation: OpenWikiOperation,
  context: { actorId?: string; scopes: OpenWikiScope[]; role?: OpenWikiRole; principals?: string[] },
  repoPath: string,
): Promise<void> {
  const repo = await loadRepository(root);
  assertPathAuthorized(operation, context, repo.policy, repoPath);
}

export async function assertMcpInboxSubmitAuthorized(
  root: string,
  context: { actorId?: string; scopes: OpenWikiScope[]; role?: OpenWikiRole; principals?: string[] },
  input: { ownerActorId?: string; targetSpaceId?: string; targetPath?: string },
): Promise<void> {
  const canSubmitForAnotherOwner = context.role === "admin" || context.scopes.includes("wiki:admin") || context.scopes.includes("wiki:inbox:admin");
  if (input.ownerActorId !== undefined && input.ownerActorId !== context.actorId && !canSubmitForAnotherOwner) {
    throw new Error(`Submitting to inbox owner ${input.ownerActorId} requires wiki:inbox:admin.`);
  }
  if (input.targetSpaceId === undefined && input.targetPath === undefined) {
    return;
  }
  const repo = await loadRepository(root);
  const sectionPath = input.targetSpaceId === undefined
    ? undefined
    : repo.policy.sections.find((section) => section.id === input.targetSpaceId)?.paths[0];
  if (input.targetSpaceId !== undefined && sectionPath === undefined) {
    throw new Error(`Unknown target_space_id '${input.targetSpaceId}'.`);
  }
  const targetPath = input.targetPath ?? sectionPath;
  if (targetPath !== undefined) {
    assertPathAuthorized("wiki.inbox_submit", context, repo.policy, targetPath, "contributor");
  }
}

export async function assertMcpReviewAuthorized(
  root: string,
  context: { actorId?: string; scopes: OpenWikiScope[]; role?: OpenWikiRole; principals?: string[] },
  proposal: ProposalRecord,
): Promise<void> {
  const repo = await loadRepository(root);
  assertReviewAuthorized(context, repo.policy, proposal);
}
