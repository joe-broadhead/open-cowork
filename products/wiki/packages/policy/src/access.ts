import { openWikiPathPatternMatches, type OpenWikiPolicyBundle, type OpenWikiRole, type ProposalRecord } from "@openwiki/core";
import type { AuthorizationResult, OpenWikiOperation, PolicyContext } from "./types.ts";
import { AuthorizationError } from "./errors.ts";
import { highestRole, mcpToolOperationsForMode, requiredScopesForOperation, requiredSectionRoleForOperation, roleAtLeast, uniqueOperations, uniqueScopes } from "./operations.ts";

/** Evaluate the scopes required for an operation without throwing. */
export function authorizeOperation(operation: OpenWikiOperation, context: PolicyContext): AuthorizationResult {
  const granted = uniqueScopes(context.scopes);
  const grantedSet = new Set(granted);
  const required = requiredScopesForOperation(operation);
  const missing = required.filter((scope) => !grantedSet.has(scope) && !grantedSet.has("wiki:admin"));
  const boundDenial = operationBoundDenial(operation, context);
  return {
    allowed: missing.length === 0 && boundDenial === undefined,
    operation,
    required_scopes: required,
    granted_scopes: granted,
    missing_scopes: missing,
    ...(boundDenial === undefined ? {} : { denied_by_bounds: true, denied_reason: boundDenial }),
    ...(context.actorId === undefined ? {} : { actor_id: context.actorId }),
  };
}

/** Evaluate an operation authorization check and throw when the actor is not allowed. */
export function assertAuthorized(operation: OpenWikiOperation, context: PolicyContext): AuthorizationResult {
  const result = authorizeOperation(operation, context);
  if (!result.allowed) {
    throw new AuthorizationError(result);
  }
  return result;
}

/** Enforce both operation scopes and section role access for a repository path. */
export function assertPathAuthorized(
  operation: OpenWikiOperation,
  context: PolicyContext,
  policy: OpenWikiPolicyBundle,
  repoPath: string,
  requiredRole = requiredSectionRoleForOperation(operation),
): AuthorizationResult {
  const result = assertAuthorized(operation, context);
  if (!canAccessPath(policy, context, repoPath, requiredRole)) {
    throw new Error(
      "OpenWiki operation '" + operation + "' requires " + requiredRole + " access to " + repoPath + " for one of: " + principalsForContext(context).join(", "),
    );
  }
  return result;
}

/** Enforce reviewer eligibility, including path role and matching approval rules. */
export function assertReviewAuthorized(
  context: PolicyContext,
  policy: OpenWikiPolicyBundle,
  proposal: Pick<ProposalRecord, "actor_id" | "target_path" | "path">,
): void {
  const targetPath = proposal.target_path ?? proposal.path;
  assertPathAuthorized("wiki.review_proposal", context, policy, targetPath, "reviewer");
  const rules = approvalRulesForPath(policy, targetPath);
  for (const rule of rules) {
    if (rule.require_separate_actor === true && context.actorId && context.actorId === proposal.actor_id) {
      throw new Error("OpenWiki approval rule '" + rule.id + "' requires a reviewer different from the proposal actor");
    }
    const requirements = rule.required_reviewers ?? [];
    if (requirements.length === 0) {
      continue;
    }
    const matched = requirements.some((requirement) => {
      const principals = new Set(principalsForContext(context));
      if (requirement.principal && !principals.has(requirement.principal)) {
        return false;
      }
      const role = requirement.role ?? "reviewer";
      return canAccessPath(policy, context, targetPath, role);
    });
    if (!matched) {
      throw new Error("OpenWiki approval rule '" + rule.id + "' requires a matching reviewer for " + targetPath);
    }
  }
}

export function canAccessPath(
  policy: OpenWikiPolicyBundle,
  context: PolicyContext,
  repoPath: string,
  requiredRole: OpenWikiRole,
): boolean {
  if (!pathAllowedByContextBounds(policy, context, repoPath)) {
    return false;
  }
  const role = sectionRoleForPath(policy, context, repoPath);
  return role === undefined ? false : roleAtLeast(role, requiredRole);
}

export function sectionRoleForPath(
  policy: OpenWikiPolicyBundle,
  context: PolicyContext,
  repoPath: string,
): OpenWikiRole | undefined {
  if (context.scopes.includes("wiki:admin")) {
    return "admin";
  }
  const sections = matchingSections(policy, repoPath);
  if (sections.length === 0) {
    return policy.sections.length === 0 ? context.role ?? "admin" : undefined;
  }
  const principals = new Set(principalsForContext(context));
  const mostSpecific = sectionSpecificity(sections[0]!);
  const sectionIds = new Set(sections.filter((section) => sectionSpecificity(section) === mostSpecific).map((section) => section.id));
  const roles = policy.grants
    .filter((grant) => sectionIds.has(grant.section) && principals.has(grant.principal))
    .map((grant) => grant.role);
  return highestRole(roles);
}

export function pathAllowedByContextBounds(
  policy: OpenWikiPolicyBundle,
  context: PolicyContext,
  repoPath: string,
): boolean {
  const bounds = context.bounds;
  if (bounds === undefined) {
    return true;
  }
  if (bounds.expiresAt !== undefined && isPastIsoTimestamp(bounds.expiresAt)) {
    return false;
  }
  if (bounds.pathPrefixes !== undefined && !pathPrefixAllowed(bounds.pathPrefixes, repoPath)) {
    return false;
  }
  if (bounds.sectionIds !== undefined) {
    const allowed = new Set(bounds.sectionIds);
    const sections = matchingSections(policy, repoPath);
    if (sections.length === 0 || !sections.some((section) => allowed.has(section.id))) {
      return false;
    }
  }
  return true;
}

export function sectionAllowedByContextBounds(context: PolicyContext, sectionId: string): boolean {
  const allowed = context.bounds?.sectionIds;
  return allowed === undefined || allowed.includes(sectionId);
}

export function principalsForContext(context: PolicyContext): string[] {
  return [
    "group:all-users",
    ...(context.actorId === undefined ? [] : [context.actorId]),
    ...(context.role === undefined ? [] : ["role:" + context.role]),
    ...(context.principals ?? []),
  ].filter((principal, index, principals) => principal.trim().length > 0 && principals.indexOf(principal) === index);
}

export function publicPathAllowed(policy: OpenWikiPolicyBundle, repoPath: string): boolean {
  return pathVisibility(policy, repoPath) === "public";
}

export function pathVisibility(policy: OpenWikiPolicyBundle, repoPath: string): "public" | "internal" | "private" {
  const sections = matchingSections(policy, repoPath);
  if (sections.length === 0) {
    return policy.sections.length === 0 ? "public" : "private";
  }
  if (sections.some((section) => section.visibility === "private")) {
    return "private";
  }
  if (sections.some((section) => section.visibility === "internal")) {
    return "internal";
  }
  return "public";
}

function approvalRulesForPath(policy: OpenWikiPolicyBundle, repoPath: string): OpenWikiPolicyBundle["approval_rules"] {
  return policy.approval_rules.filter((rule) => rule.paths.some((pattern) => pathMatches(pattern, repoPath)));
}

export function matchingSections(policy: OpenWikiPolicyBundle, repoPath: string): OpenWikiPolicyBundle["sections"] {
  return policy.sections
    .filter((section) => section.paths.some((pattern) => pathMatches(pattern, repoPath)))
    .sort((left, right) => sectionSpecificity(right) - sectionSpecificity(left));
}

function sectionSpecificity(section: OpenWikiPolicyBundle["sections"][number]): number {
  return Math.max(...section.paths.map((pattern) => pattern.replace(/[/*?]/g, "").length), 0);
}

function pathMatches(pattern: string, repoPath: string): boolean {
  return openWikiPathPatternMatches(pattern, repoPath);
}

function operationBoundDenial(operation: OpenWikiOperation, context: PolicyContext): string | undefined {
  const bounds = context.bounds;
  if (bounds === undefined) {
    return undefined;
  }
  if (bounds.expiresAt !== undefined && isPastIsoTimestamp(bounds.expiresAt)) {
    return "expired";
  }
  const allowed = operationsAllowedByBounds(context);
  if (allowed !== undefined && !allowed.has(operation)) {
    return "operation_not_allowed";
  }
  return undefined;
}

function operationsAllowedByBounds(context: PolicyContext): Set<OpenWikiOperation> | undefined {
  const bounds = context.bounds;
  if (bounds === undefined) {
    return undefined;
  }
  const operationBounds = bounds.operations === undefined ? undefined : uniqueOperations(bounds.operations);
  const modeBounds = bounds.toolModes === undefined ? undefined : uniqueOperations(bounds.toolModes.flatMap((mode) => mcpToolOperationsForMode(mode)));
  if (operationBounds === undefined && modeBounds === undefined) {
    return undefined;
  }
  const allowed = operationBounds === undefined
    ? modeBounds ?? []
    : modeBounds === undefined
      ? operationBounds
      : operationBounds.filter((operation) => modeBounds.includes(operation));
  return new Set(allowed);
}

function pathPrefixAllowed(prefixes: string[], repoPath: string): boolean {
  const normalizedPath = normalizeRepoPathForBounds(repoPath);
  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizeRepoPathForBounds(prefix);
    return normalizedPath === normalizedPrefix || normalizedPath.startsWith(normalizedPrefix + "/");
  });
}

function normalizeRepoPathForBounds(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "");
}

function isPastIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}
