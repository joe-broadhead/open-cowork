import { findTrajectory, forgetFact, listFacts, listTakes, proposeFact, proposeTake, readFactWorkflow, readTakeWorkflow, recallWiki, resolveTake, takesScorecard } from "@openwiki/workflows";
import type { FactStatus, TakeResolution, TakeStatus } from "@openwiki/core";
import {
  boundedOptionalNumberParam,
  optionalBooleanParam,
  optionalNumberParam,
  optionalSearchStringArrayParam,
  optionalStringArrayParam,
  optionalStringObjectProperty,
  optionalStringParam,
  stringParam,
} from "./params.ts";
import { MCP_LIST_LIMIT_MAX, type McpPolicyContext } from "./types.ts";

export async function recallFromMcp(root: string, args: Record<string, unknown>, policyContext: McpPolicyContext): Promise<unknown> {
  const limit = boundedOptionalNumberParam(args, "limit", MCP_LIST_LIMIT_MAX);
  return recallWiki({
    root,
    query: stringParam(args, "query"),
    includeExplain: optionalBooleanParam(args, "include_explain") ?? false,
    includeHighlights: optionalBooleanParam(args, "include_highlights") ?? false,
    ...optionalSearchStringArrayParam(args, "types", "types"),
    ...(limit === undefined ? {} : { limit }),
    policyContext,
  });
}

export async function listFactsFromMcp(root: string, args: Record<string, unknown>, policyContext: McpPolicyContext): Promise<unknown> {
  const limit = boundedOptionalNumberParam(args, "limit", MCP_LIST_LIMIT_MAX);
  return listFacts({
    root,
    ...factStatusesFromMcp(args),
    ...optionalStringArrayObjectProperty(args, "kinds", "kinds"),
    ...optionalStringArrayObjectProperty(args, "subject_ids", "subjectIds"),
    ...optionalStringArrayObjectProperty(args, "page_ids", "pageIds"),
    ...optionalStringArrayObjectProperty(args, "source_ids", "sourceIds"),
    ...optionalStringArrayObjectProperty(args, "claim_ids", "claimIds"),
    ...(limit === undefined ? {} : { limit }),
    policyContext,
  });
}

export async function readFactFromMcp(root: string, args: Record<string, unknown>, policyContext: McpPolicyContext): Promise<unknown> {
  return readFactWorkflow({ root, id: stringParam(args, "id"), policyContext });
}

export async function listTakesFromMcp(root: string, args: Record<string, unknown>, policyContext: McpPolicyContext): Promise<unknown> {
  const limit = boundedOptionalNumberParam(args, "limit", MCP_LIST_LIMIT_MAX);
  return listTakes({
    root,
    ...takeStatusesFromMcp(args),
    ...optionalStringArrayObjectProperty(args, "page_ids", "pageIds"),
    ...optionalStringArrayObjectProperty(args, "source_ids", "sourceIds"),
    ...optionalStringArrayObjectProperty(args, "claim_ids", "claimIds"),
    ...(limit === undefined ? {} : { limit }),
    policyContext,
  });
}

export async function readTakeFromMcp(root: string, args: Record<string, unknown>, policyContext: McpPolicyContext): Promise<unknown> {
  return readTakeWorkflow({ root, id: stringParam(args, "id"), policyContext });
}

export async function takesScorecardFromMcp(root: string, policyContext: McpPolicyContext): Promise<unknown> {
  return takesScorecard({ root, policyContext });
}

export async function findTrajectoryFromMcp(root: string, args: Record<string, unknown>, policyContext: McpPolicyContext): Promise<unknown> {
  const limit = boundedOptionalNumberParam(args, "limit", MCP_LIST_LIMIT_MAX);
  return findTrajectory({
    root,
    ...optionalStringObjectProperty(args, "id", "id"),
    ...optionalStringObjectProperty(args, "query", "query"),
    ...trajectoryOrderFromMcp(args),
    ...(limit === undefined ? {} : { limit }),
    policyContext,
  });
}

export async function proposeFactFromMcp(root: string, args: Record<string, unknown>, policyContext?: McpPolicyContext, authenticatedActorId?: string): Promise<unknown> {
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  return proposeFact({
    root,
    ...optionalStringObjectProperty(args, "id", "id"),
    ...optionalStringObjectProperty(args, "kind", "kind"),
    text: stringParam(args, "text"),
    ...optionalStringArrayObjectProperty(args, "subject_ids", "subjectIds"),
    ...optionalStringArrayObjectProperty(args, "page_ids", "pageIds"),
    ...optionalStringArrayObjectProperty(args, "source_ids", "sourceIds"),
    ...optionalStringArrayObjectProperty(args, "claim_ids", "claimIds"),
    ...factConfidenceFromMcp(args),
    ...factSensitivityFromMcp(args),
    ...factStatusFromMcp(args),
    ...optionalStringObjectProperty(args, "valid_from", "validFrom"),
    ...optionalStringObjectProperty(args, "valid_to", "validTo"),
    ...(actorId === undefined ? {} : { actorId }),
    ...optionalStringObjectProperty(args, "rationale", "rationale"),
    ...(policyContext === undefined ? {} : { policyContext }),
  });
}

export async function proposeTakeFromMcp(root: string, args: Record<string, unknown>, policyContext?: McpPolicyContext, authenticatedActorId?: string): Promise<unknown> {
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  return proposeTake({
    root,
    ...optionalStringObjectProperty(args, "id", "id"),
    statement: stringParam(args, "statement"),
    ...optionalStringObjectProperty(args, "rationale", "rationale"),
    ...optionalNumberObjectProperty(args, "probability", "probability"),
    ...takeConfidenceFromMcp(args),
    ...takeStatusFromMcp(args),
    ...optionalStringObjectProperty(args, "due_at", "dueAt"),
    ...optionalStringArrayObjectProperty(args, "page_ids", "pageIds"),
    ...optionalStringArrayObjectProperty(args, "source_ids", "sourceIds"),
    ...optionalStringArrayObjectProperty(args, "claim_ids", "claimIds"),
    ...(actorId === undefined ? {} : { actorId }),
    ...optionalStringObjectProperty(args, "proposal_rationale", "proposalRationale"),
    ...(policyContext === undefined ? {} : { policyContext }),
  });
}

export async function resolveTakeFromMcp(root: string, args: Record<string, unknown>, policyContext?: McpPolicyContext, authenticatedActorId?: string): Promise<unknown> {
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  return resolveTake({
    root,
    id: stringParam(args, "id"),
    resolution: takeResolutionFromMcp(args),
    ...optionalStringObjectProperty(args, "resolved_at", "resolvedAt"),
    ...(actorId === undefined ? {} : { actorId }),
    ...optionalStringObjectProperty(args, "rationale", "rationale"),
    ...(policyContext === undefined ? {} : { policyContext }),
  });
}

export async function forgetFactFromMcp(root: string, args: Record<string, unknown>, policyContext?: McpPolicyContext, authenticatedActorId?: string): Promise<unknown> {
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  return forgetFact({
    root,
    id: stringParam(args, "id"),
    ...optionalStringObjectProperty(args, "valid_to", "validTo"),
    ...(actorId === undefined ? {} : { actorId }),
    ...optionalStringObjectProperty(args, "rationale", "rationale"),
    ...(policyContext === undefined ? {} : { policyContext }),
  });
}

function optionalStringArrayObjectProperty<Key extends string>(
  args: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, string[]>> {
  const value = optionalStringArrayParam(args, inputKey);
  return value === undefined ? {} : ({ [outputKey]: value } as Partial<Record<Key, string[]>>);
}

function optionalNumberObjectProperty<Key extends string>(
  args: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, number>> {
  const value = optionalNumberParam(args, inputKey);
  return value === undefined ? {} : ({ [outputKey]: value } as Partial<Record<Key, number>>);
}

function factStatusesFromMcp(args: Record<string, unknown>): { statuses?: FactStatus[] } {
  const values = optionalStringArrayParam(args, "statuses");
  return values === undefined ? {} : { statuses: values.map(factStatusParam) };
}

function factStatusFromMcp(args: Record<string, unknown>): { status?: FactStatus } {
  const value = optionalStringParam(args, "status");
  return value === undefined ? {} : { status: factStatusParam(value) };
}

function factStatusParam(value: string): FactStatus {
  if (value === "active" || value === "stale" || value === "disputed" || value === "forgotten" || value === "archived") {
    return value;
  }
  throw new Error(`Invalid fact status '${value}'`);
}

function takeStatusesFromMcp(args: Record<string, unknown>): { statuses?: TakeStatus[] } {
  const values = optionalStringArrayParam(args, "statuses");
  return values === undefined ? {} : { statuses: values.map(takeStatusParam) };
}

function takeStatusFromMcp(args: Record<string, unknown>): { status?: TakeStatus } {
  const value = optionalStringParam(args, "status");
  return value === undefined ? {} : { status: takeStatusParam(value) };
}

function takeStatusParam(value: string): TakeStatus {
  if (value === "open" || value === "resolved" || value === "archived") {
    return value;
  }
  throw new Error(`Invalid take status '${value}'`);
}

function takeResolutionFromMcp(args: Record<string, unknown>): TakeResolution {
  const value = stringParam(args, "resolution");
  if (value === "correct" || value === "incorrect" || value === "partial" || value === "unresolvable") {
    return value;
  }
  throw new Error(`Invalid take resolution '${value}'`);
}

function factConfidenceFromMcp(args: Record<string, unknown>): { confidence?: "low" | "medium" | "high" } {
  const value = optionalStringParam(args, "confidence");
  return value === undefined ? {} : { confidence: confidenceParam(value) };
}

function takeConfidenceFromMcp(args: Record<string, unknown>): { confidence?: "low" | "medium" | "high" } {
  const value = optionalStringParam(args, "confidence");
  return value === undefined ? {} : { confidence: confidenceParam(value) };
}

function confidenceParam(value: string): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new Error(`Invalid confidence '${value}'`);
}

function factSensitivityFromMcp(args: Record<string, unknown>): { sensitivity?: "public" | "internal" | "private" } {
  const value = optionalStringParam(args, "sensitivity");
  if (value === undefined) {
    return {};
  }
  if (value === "public" || value === "internal" || value === "private") {
    return { sensitivity: value };
  }
  throw new Error(`Invalid fact sensitivity '${value}'`);
}

function trajectoryOrderFromMcp(args: Record<string, unknown>): { order?: "asc" | "desc" } {
  const value = optionalStringParam(args, "order");
  if (value === undefined) {
    return {};
  }
  if (value === "asc" || value === "desc") {
    return { order: value };
  }
  throw new Error(`Invalid trajectory order '${value}'`);
}
