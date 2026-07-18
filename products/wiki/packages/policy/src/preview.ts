import { uniqueStrings, type OpenWikiConfig, type OpenWikiPolicyBundle, type OpenWikiRole, type OpenWikiRuntimePrincipalRecord } from "@openwiki/core";
import type { EffectivePermissionRecord, OpenWikiOperation, PermissionAccessMatrix, PermissionOperationPreview, PermissionPathPreview, PermissionPreview, PermissionPreviewOptions, PermissionRecordPreview, PermissionSectionPreview, PolicyContext, PolicyIdentitySummary, PolicyVisibilityRepository } from "./types.ts";
import { sanitizeServiceAccount } from "./service-accounts.ts";
import { authorizeOperation, matchingSections, pathVisibility, principalsForContext, sectionRoleForPath } from "./access.ts";
import { canReadRecordId } from "./visibility.ts";
import { highestRole, operationNames, requiredSectionRoleForOperation, roleAtLeast, roleLevel, scopesForRole, uniqueOperations, uniqueScopes } from "./operations.ts";

/** Build the human-facing Spaces & Permissions preview for an actor and optional records/paths. */
export function previewPermissions(
  policy: OpenWikiPolicyBundle,
  context: PolicyContext,
  options: PermissionPreviewOptions = {},
): PermissionPreview {
  const principals = principalsForContext(context);
  const scopes = uniqueScopes(context.scopes);
  const paths = uniqueStrings(options.paths ?? []);
  const operationList = options.operations?.length ? uniqueOperations(options.operations) : operationNames();
  return {
    ...(context.actorId === undefined ? {} : { actor_id: context.actorId }),
    ...(context.role === undefined ? {} : { role: context.role }),
    principals,
    scopes,
    sections: policy.sections.map((section) => previewSection(policy, context, section)),
    paths: paths.map((repoPath) => previewPath(policy, context, repoPath)),
    records: uniqueStrings(options.recordIds ?? []).map((recordId) => previewRecord(options.repo, context, recordId)),
    operations: operationList.map((operation) => previewOperation(policy, context, operation, paths[0])),
  };
}

/** Summarize configured principals, groups, and service accounts for admin permission views. */
export function summarizePolicyIdentities(
  config: Pick<OpenWikiConfig, "auth">,
  policy: OpenWikiPolicyBundle,
): PolicyIdentitySummary {
  const principalIds = new Set<string>();
  for (const grant of policy.grants) {
    principalIds.add(grant.principal);
  }
  for (const account of config.auth?.service_accounts ?? []) {
    principalIds.add(account.id);
    principalIds.add(account.actor_id);
    for (const principal of account.principals ?? []) {
      principalIds.add(principal);
    }
  }
  principalIds.add("group:all-users");
  const principals = [...principalIds].sort().map((principalId) => ({
    id: principalId,
    type: runtimePrincipalType(principalId),
    title: principalTitle(principalId),
  }));
  const groups = principals
    .filter((principal) => principal.type === "group")
    .map((principal) => ({ id: principal.id, title: principal.title }));
  const principalGroups = (config.auth?.service_accounts ?? []).flatMap((account) =>
    (account.principals ?? [])
      .filter((principal) => principal.startsWith("group:"))
      .map((principal) => ({ principal_id: account.actor_id, group_id: principal, source: "git" as const })),
  );
  const serviceAccounts = (config.auth?.service_accounts ?? []).map((account) => sanitizeServiceAccount(account));
  return {
    source: "git-policy",
    principals,
    groups,
    principal_groups: principalGroups,
    service_accounts: serviceAccounts,
  };
}

export function materializeEffectivePermissions(
  config: Pick<OpenWikiConfig, "auth">,
  policy: OpenWikiPolicyBundle,
): EffectivePermissionRecord[] {
  const records = new Map<string, EffectivePermissionRecord>();
  for (const grant of policy.grants) {
    upsertEffectivePermission(records, grant.principal, grant.section, grant.role);
  }
  for (const account of config.auth?.service_accounts ?? []) {
    const accountPrincipals = new Set([account.id, account.actor_id, ...(account.principals ?? [])]);
    for (const grant of policy.grants) {
      if (!accountPrincipals.has(grant.principal)) {
        continue;
      }
      upsertEffectivePermission(records, account.actor_id, grant.section, grant.role);
      upsertEffectivePermission(records, account.id, grant.section, grant.role);
    }
  }
  return [...records.values()].sort(
    (left, right) => left.principal.localeCompare(right.principal) || left.section.localeCompare(right.section),
  );
}

function previewSection(
  policy: OpenWikiPolicyBundle,
  context: PolicyContext,
  section: OpenWikiPolicyBundle["sections"][number],
): PermissionSectionPreview {
  const principals = new Set(principalsForContext(context));
  const matchingGrants = policy.grants
    .filter((grant) => grant.section === section.id && principals.has(grant.principal))
    .map((grant) => ({ principal: grant.principal, section: grant.section, role: grant.role }));
  const role = context.scopes.includes("wiki:admin") ? "admin" : highestRole(matchingGrants.map((grant) => grant.role));
  return {
    id: section.id,
    title: section.title,
    paths: [...section.paths],
    visibility: section.visibility ?? "public",
    matching_grants: matchingGrants,
    access: accessMatrixForRole(role),
    ...(role === undefined ? {} : { role, scopes: scopesForRole(role) }),
    ...(section.description === undefined ? {} : { description: section.description }),
  };
}

function previewPath(policy: OpenWikiPolicyBundle, context: PolicyContext, repoPath: string): PermissionPathPreview {
  const role = sectionRoleForPath(policy, context, repoPath);
  return {
    path: repoPath,
    visibility: pathVisibility(policy, repoPath),
    matching_sections: matchingSections(policy, repoPath).map((section) => ({
      id: section.id,
      title: section.title,
      visibility: section.visibility ?? "public",
      paths: [...section.paths],
    })),
    access: accessMatrixForRole(role),
    allowed_operations: operationNames().filter((operation) => previewOperation(policy, context, operation, repoPath).allowed),
    ...(role === undefined ? {} : { role }),
  };
}

function previewRecord(
  repo: PolicyVisibilityRepository | undefined,
  context: PolicyContext,
  recordId: string,
): PermissionRecordPreview {
  if (!repo) {
    return { id: recordId, visible: false, reason: "Repository context was not provided for record visibility evaluation." };
  }
  const reference = recordPreviewReference(repo, recordId);
  if (reference === undefined) {
    return { id: recordId, visible: false, reason: "No record with this id or URI exists in the workspace." };
  }
  const visible = canReadRecordId(repo, context, recordId);
  if (reference.path === undefined) {
    return {
      id: recordId,
      visible,
      ...(reference.type === undefined ? {} : { type: reference.type }),
      reason: visible
        ? "The record is visible through its parent record or explicit subject policy."
        : "The record has no direct policy path and no visible parent record for this actor.",
    };
  }
  const pathRole = sectionRoleForPath(repo.policy, context, reference.path);
  const visibility = pathVisibility(repo.policy, reference.path);
  const matchedSections = matchingSections(repo.policy, reference.path).map((section) => ({
    id: section.id,
    title: section.title,
    visibility: section.visibility ?? "public",
    paths: [...section.paths],
  }));
  return {
    id: recordId,
    visible,
    ...(reference.type === undefined ? {} : { type: reference.type }),
    path: reference.path,
    visibility,
    matching_sections: matchedSections,
    required_role: "viewer",
    ...(pathRole === undefined ? {} : { role: pathRole }),
    reason: recordPreviewReason({
      visible,
      path: reference.path,
      role: pathRole,
      matchingSectionCount: matchedSections.length,
      adminScope: context.scopes.includes("wiki:admin"),
      policyHasSections: repo.policy.sections.length > 0,
    }),
  };
}

function recordPreviewReason(input: {
  visible: boolean;
  path: string;
  role: OpenWikiRole | undefined;
  matchingSectionCount: number;
  adminScope: boolean;
  policyHasSections: boolean;
}): string {
  if (input.adminScope) {
    return "Allowed because the context includes wiki:admin scope.";
  }
  if (input.visible && input.role !== undefined) {
    return `Allowed because the actor has ${input.role} access to ${input.path}, which satisfies the viewer requirement.`;
  }
  if (!input.policyHasSections) {
    return "Denied because no Space policy is configured and the context does not include an explicit readable role.";
  }
  if (input.matchingSectionCount === 0) {
    return `Denied because no Space covers ${input.path}.`;
  }
  return "Denied because the matching Space grants do not give this actor or principal viewer access.";
}

function previewOperation(
  policy: OpenWikiPolicyBundle,
  context: PolicyContext,
  operation: OpenWikiOperation,
  repoPath: string | undefined,
): PermissionOperationPreview {
  const authorization = authorizeOperation(operation, context);
  if (repoPath === undefined) {
    return {
      ...authorization,
      scope_allowed: authorization.allowed,
    };
  }
  const requiredRole = requiredSectionRoleForOperation(operation);
  const pathRole = sectionRoleForPath(policy, context, repoPath);
  const pathAllowed = pathRole !== undefined && roleAtLeast(pathRole, requiredRole);
  return {
    ...authorization,
    allowed: authorization.allowed && pathAllowed,
    scope_allowed: authorization.allowed,
    required_section_role: requiredRole,
    path: repoPath,
    path_allowed: pathAllowed,
    ...(pathRole === undefined ? {} : { path_role: pathRole }),
  };
}

function recordPreviewReference(
  repo: PolicyVisibilityRepository,
  recordId: string,
): { type?: string; path?: string } | undefined {
  const page = repo.pages.find((candidate) => candidate.id === recordId || candidate.uri === recordId);
  if (page) return { type: "page", path: page.path };
  const source = repo.sources.find((candidate) => candidate.id === recordId || candidate.uri === recordId);
  if (source) return { type: "source", path: source.path };
  const claim = repo.claims.find((candidate) => candidate.id === recordId || candidate.uri === recordId);
  if (claim) {
    const page = repo.pages.find((candidate) => candidate.id === claim.page_id || candidate.claim_ids.includes(claim.id));
    return { type: "claim", ...(page === undefined ? {} : { path: page.path }) };
  }
  const fact = repo.facts.find((candidate) => candidate.id === recordId || candidate.uri === recordId);
  if (fact) return { type: "fact", path: fact.path };
  const take = repo.takes.find((candidate) => candidate.id === recordId || candidate.uri === recordId);
  if (take) return { type: "take", path: take.path };
  const inboxItem = repo.inbox.find((candidate) => candidate.id === recordId || candidate.uri === recordId);
  if (inboxItem) return { type: "inbox", path: inboxItem.target_path ?? inboxItem.payload?.path ?? inboxItem.path };
  const proposal = repo.proposals.find((candidate) => candidate.id === recordId || candidate.uri === recordId);
  if (proposal) return { type: "proposal", path: proposal.target_path ?? proposal.path };
  const comment = repo.comments.find((candidate) => candidate.id === recordId || candidate.uri === recordId);
  if (comment) {
    const proposal = repo.proposals.find((candidate) => candidate.id === comment.proposal_id);
    return { type: "comment", ...(proposal?.target_path === undefined ? {} : { path: proposal.target_path }) };
  }
  const decision = repo.decisions.find((candidate) => candidate.id === recordId || candidate.uri === recordId);
  if (decision) {
    const proposal = repo.proposals.find((candidate) => candidate.id === decision.proposal_id);
    return { type: "decision", ...(proposal?.target_path === undefined ? {} : { path: proposal.target_path }) };
  }
  const event = repo.events.find((candidate) => candidate.id === recordId || candidate.uri === recordId);
  if (event) return { type: "event", path: event.path };
  const run = repo.runs.find((candidate) => candidate.id === recordId || candidate.uri === recordId);
  if (run) return { type: "run", path: run.path };
  return undefined;
}

function accessMatrixForRole(role: OpenWikiRole | undefined): PermissionAccessMatrix {
  return {
    read: role !== undefined && roleAtLeast(role, "viewer"),
    propose: role !== undefined && roleAtLeast(role, "contributor"),
    review: role !== undefined && roleAtLeast(role, "reviewer"),
    maintain: role !== undefined && roleAtLeast(role, "maintainer"),
    admin: role !== undefined && roleAtLeast(role, "admin"),
  };
}

function upsertEffectivePermission(
  records: Map<string, EffectivePermissionRecord>,
  principal: string,
  section: string,
  role: OpenWikiRole,
): void {
  const key = principal + "\u0000" + section;
  const existing = records.get(key);
  const nextRole = existing === undefined || roleLevel(role) > roleLevel(existing.role) ? role : existing.role;
  records.set(key, {
    principal,
    section,
    role: nextRole,
    scopes: scopesForRole(nextRole),
  });
}

function runtimePrincipalType(id: string): OpenWikiRuntimePrincipalRecord["type"] {
  if (id.startsWith("group:")) return "group";
  if (id.startsWith("service:")) return "service_account";
  if (id.startsWith("actor:agent:")) return "service_account";
  if (id.startsWith("actor:")) return "actor";
  if (id.startsWith("role:")) return "role";
  if (id.startsWith("user:")) return "user";
  return "principal";
}

function principalTitle(id: string): string {
  return id.split(":").slice(1).join(":") || id;
}
