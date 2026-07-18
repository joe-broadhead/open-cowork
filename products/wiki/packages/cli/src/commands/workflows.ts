import { readFile } from "node:fs/promises";
import path from "node:path";
import type { OpenWikiPolicyBundle, OpenWikiRole } from "@openwiki/core";
import { configureGitRemote } from "@openwiki/git";
import { listCurrentIndexStoreProposals, readCurrentIndexStoreWorkspaceRegistry } from "@openwiki/index-store";
import { parseOpenWikiOperation, parsePolicyFileName, parseProposalStatus } from "../args.ts";
import type { CliOptions } from "../args.ts";
import { parseServiceAccountTokenProfile } from "../arg-values.ts";
import { printJson } from "../output.ts";
import { previewPermissions, scopesForRole, summarizePolicyIdentities } from "@openwiki/policy";
import { listCurrentPostgresIdentities, listCurrentPostgresProposals, readCurrentPostgresWorkspaceRegistry } from "@openwiki/postgres-runtime";
import { listProposals, loadRepository, readProposal, readProposalDetail, readWorkspaceRegistry } from "@openwiki/repo";
import { applyProposal, closeProposal, commentOnProposal, createServiceAccountToken, createSynthesis, inspectServiceAccountToken, listServiceAccountTokens, proposeEdit, proposePolicyChange, proposeSectionPolicy, proposeSynthesis, reviewProposal, revokeServiceAccountToken, rotateServiceAccountToken } from "@openwiki/workflows";
import { resolveRoot } from "../utils.ts";

export async function proposeEditCommand(args: string[], options: CliOptions): Promise<void> {
  const [pageId] = args;
  if (!pageId || !options.bodyFile) {
    throw new Error(
      "Usage: openwiki [--root <path>] propose-edit <page-id> --body-file <path> [--source source:id] [--claim claim:id] [--actor actor:user:local] [--rationale text] [--summary text] [--title text] [--json]",
    );
  }
  const body = await readFile(path.resolve(options.bodyFile), "utf8");
  const result = await proposeEdit({
    root: await resolveRoot(options),
    pageId,
    body,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    ...(options.sourceIds.length === 0 ? {} : { sourceIds: options.sourceIds }),
    ...(options.claimIds.length === 0 ? {} : { claimIds: options.claimIds }),
    ...(options.actor === undefined ? {} : { actorId: options.actor }),
    ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`Created proposal ${result.proposal.id}`);
  console.log(result.proposal.diff.path);
  console.log(result.validation.status);
}

export async function synthesizeCommand(options: CliOptions): Promise<void> {
  if (!options.title || !options.bodyFile) {
    throw new Error(
      "Usage: openwiki [--root <path>] synthesize --title text --body-file <path> [--apply] [--page-type concept] [--summary text] [--topic topic] [--source source:id] [--actor actor:user:local] [--rationale text] [--json]",
    );
  }
  const root = await resolveRoot(options);
  const body = await readFile(path.resolve(options.bodyFile), "utf8");
  const input = {
    root,
    title: options.title,
    body,
    ...(options.pageType === undefined ? {} : { pageType: options.pageType }),
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    ...(options.topics.length === 0 ? {} : { topics: options.topics }),
    ...(options.sourceIds.length === 0 ? {} : { sourceIds: options.sourceIds }),
    ...(options.actor === undefined ? {} : { actorId: options.actor }),
    ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
  };
  const result = options.applySynthesis ? await createSynthesis(input) : await proposeSynthesis(input);
  if (options.json) {
    printJson(result);
    return;
  }
  if (options.applySynthesis) {
    const applied = result as Awaited<ReturnType<typeof createSynthesis>>;
    console.log(`Created synthesis page ${applied.page.id}`);
    for (const appliedPath of applied.applied_paths) {
      console.log(appliedPath);
    }
    return;
  }
  const proposed = result as Awaited<ReturnType<typeof proposeSynthesis>>;
  console.log(`Created synthesis proposal ${proposed.proposal.id}`);
  console.log(proposed.proposal.target_path);
  console.log(proposed.validation.status);
}

export async function policyCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, policyFile] = args;
  const root = await resolveRoot(options);
  if (subcommand === "read") {
    const repo = await loadRepository(root);
    printJson({ policy: repo.policy });
    return;
  }
  if (subcommand === "identities") {
    const repo = await loadRepository(root);
    const identities = (await listCurrentPostgresIdentities(root)) ?? {
      workspace_id: repo.config.workspace_id,
      ...summarizePolicyIdentities(repo.config, repo.policy),
    };
    if (options.json) {
      printJson({ identities });
      return;
    }
    console.log(`Principals: ${identities.principals.length}`);
    console.log(`Groups: ${identities.groups.length}`);
    console.log(`Service accounts: ${identities.service_accounts.length}`);
    return;
  }
  if (subcommand === "preview") {
    const repo = await loadRepository(root);
    const role = options.mcpRole;
    const scopes = options.mcpScopes.length === 0 ? scopesForRole(role ?? "viewer") : options.mcpScopes;
    const context = {
      scopes,
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(role === undefined ? {} : { role }),
      ...(options.principals.length === 0 ? {} : { principals: options.principals }),
    };
    const preview = previewPermissions(repo.policy, context, {
      repo,
      ...(options.targetPath === undefined ? {} : { paths: [options.targetPath] }),
      ...(options.targetId === undefined ? {} : { recordIds: [options.targetId] }),
      ...(options.operation === undefined ? {} : { operations: [parseOpenWikiOperation(options.operation)] }),
    });
    if (options.json) {
      printJson({ preview });
      return;
    }
    console.log(`Actor: ${preview.actor_id ?? "anonymous"}`);
    console.log(`Principals: ${preview.principals.join(", ")}`);
    console.log(`Scopes: ${preview.scopes.join(", ")}`);
    if (preview.paths.length > 0) {
      for (const entry of preview.paths) {
        console.log(`${entry.path}: ${entry.role ?? "none"} (${entry.visibility})`);
      }
    }
    if (preview.records.length > 0) {
      for (const record of preview.records) {
        console.log(`${record.id}: ${record.visible ? "visible" : "hidden"}${record.path ? ` ${record.path}` : ""}`);
        console.log(`  why: ${record.reason}`);
      }
    }
    if (preview.operations.length > 0) {
      for (const operationPreview of preview.operations) {
        const pathReason =
          operationPreview.path_allowed === false && operationPreview.required_section_role !== undefined
            ? `; path requires ${operationPreview.required_section_role} access`
            : "";
        const scopeReason = operationPreview.scope_allowed ? "" : `; missing scopes ${operationPreview.missing_scopes.join(", ")}`;
        console.log(`${operationPreview.operation}: ${operationPreview.allowed ? "allowed" : "denied"}${scopeReason}${pathReason}`);
      }
    }
    return;
  }
  if (subcommand === "propose" && policyFile) {
    if (!options.bodyFile) {
      throw new Error(
        "Usage: openwiki [--root <path>] policy propose sections|grants|approval-rules --body-file <path> [--actor actor:user:local] [--rationale text] [--json]",
      );
    }
    const result = await proposePolicyChange({
      root,
      policyFile: parsePolicyFileName(policyFile),
      body: await readFile(path.resolve(options.bodyFile), "utf8"),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Created policy proposal ${result.proposal.id}`);
    console.log(result.target_path);
    console.log(result.validation.status);
    return;
  }
  if (subcommand === "propose-section") {
    if (!options.sectionId || !options.title || options.sectionPaths.length === 0) {
      throw new Error(
        "Usage: openwiki [--root <path>] policy propose-section --section section:id --title text --path wiki/team/** [--viewer group:team] [--reviewer group:team-reviewers] [--admin group:team-admins] [--replace-grants] [--actor actor:user:local] [--rationale text] [--json]",
      );
    }
    const result = await proposeSectionPolicy({
      root,
      sectionId: options.sectionId,
      title: options.title,
      paths: options.sectionPaths,
      ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
      ...(options.ownerPrincipal === undefined ? {} : { ownerPrincipal: options.ownerPrincipal }),
      viewerPrincipals: options.viewerPrincipals,
      contributorPrincipals: options.contributorPrincipals,
      researcherPrincipals: options.researcherPrincipals,
      reviewerPrincipals: options.reviewerPrincipals,
      maintainerPrincipals: options.maintainerPrincipals,
      adminPrincipals: options.adminPrincipals,
      requiredReviewerPrincipals: options.requiredReviewerPrincipals,
      ...(options.replaceGrants ? { replaceGrants: true } : {}),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Created section policy proposal ${result.proposal.id}`);
    console.log(result.section.id);
    console.log(result.validation.status);
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] policy read|identities|preview|propose|propose-section ...");
}

export async function spacesCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand = "list", idOrPolicyFile] = args;
  if (subcommand === "list") {
    const root = await resolveRoot(options);
    const repo = await loadRepository(root);
    const result = { spaces: policySpaces(repo.policy), total: repo.policy.sections.length };
    if (options.json) {
      printJson(result);
      return;
    }
    for (const space of result.spaces) {
      console.log(`${space.id}\t${space.title}\t${space.visibility}\t${space.path_coverage.join(",")}`);
    }
    return;
  }
  if ((subcommand === "read" || subcommand === "show") && idOrPolicyFile !== undefined) {
    const root = await resolveRoot(options);
    const repo = await loadRepository(root);
    const space = policySpaces(repo.policy).find((candidate) => candidate.id === idOrPolicyFile);
    if (space === undefined) {
      throw new Error(`Space '${idOrPolicyFile}' was not found.`);
    }
    if (options.json) {
      printJson({ space });
      return;
    }
    console.log(`${space.id}: ${space.title}`);
    console.log(`Visibility: ${space.visibility}`);
    console.log(`Paths: ${space.path_coverage.join(", ")}`);
    console.log(`Viewers: ${space.viewers.join(", ") || "(none)"}`);
    console.log(`Contributors: ${space.contributors.join(", ") || "(none)"}`);
    console.log(`Reviewers: ${space.reviewers.join(", ") || "(none)"}`);
    console.log(`Maintainers: ${space.maintainers.join(", ") || "(none)"}`);
    console.log(`Admins: ${space.admins.join(", ") || "(none)"}`);
    return;
  }
  if (subcommand === "preview") {
    await policyCommand(["preview"], options);
    return;
  }
  if (subcommand === "create") {
    await policyCommand(["propose-section"], options);
    return;
  }
  if (subcommand === "edit-advanced" && idOrPolicyFile !== undefined) {
    await policyCommand(["propose", idOrPolicyFile], options);
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] spaces list|read <section:id>|preview|create|edit-advanced sections|grants|approval-rules [--json]");
}

function policySpaces(policy: OpenWikiPolicyBundle): Array<{
  id: string;
  title: string;
  visibility: string;
  path_coverage: string[];
  viewers: string[];
  researchers: string[];
  contributors: string[];
  reviewers: string[];
  maintainers: string[];
  admins: string[];
  approval_rules: string[];
}> {
  return policy.sections.map((section) => {
    const grants = policy.grants.filter((grant) => grant.section === section.id);
    return {
      id: section.id,
      title: section.title,
      visibility: section.visibility ?? "internal",
      path_coverage: section.paths,
      viewers: principalsForRole(grants, "viewer"),
      researchers: principalsForRole(grants, "researcher"),
      contributors: principalsForRole(grants, "contributor"),
      reviewers: principalsForRole(grants, "reviewer"),
      maintainers: principalsForRole(grants, "maintainer"),
      admins: principalsForRole(grants, "admin"),
      approval_rules: policy.approval_rules.filter((rule) => rule.paths.some((rulePath) => section.paths.includes(rulePath))).map((rule) => rule.id),
    };
  });
}

function principalsForRole(grants: OpenWikiPolicyBundle["grants"], role: OpenWikiRole): string[] {
  return grants.filter((grant) => grant.role === role).map((grant) => grant.principal).sort();
}

export async function authCommand(args: string[], options: CliOptions): Promise<void> {
  const [resource, action, maybeId] = args;
  if (resource !== "token") {
    throw new Error("Usage: openwiki [--root <path>] auth token create|list|inspect|revoke|rotate");
  }
  const root = await resolveRoot(options);
  if (action === "create") {
    if (options.profile !== undefined && options.authTokenProfile === undefined) {
      parseServiceAccountTokenProfile(options.profile);
    }
    const result = await createServiceAccountToken({
      root,
      ...(options.targetId === undefined && maybeId === undefined ? {} : { id: options.targetId ?? maybeId }),
      ...(options.authTokenProfile === undefined ? {} : { profile: options.authTokenProfile }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.mcpRole === undefined ? {} : { role: options.mcpRole }),
      ...(options.mcpScopes.length === 0 ? {} : { scopes: options.mcpScopes }),
      ...(options.principals.length === 0 ? {} : { principals: options.principals }),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      ...(options.expiresInDays === undefined ? {} : { expiresInDays: options.expiresInDays }),
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.tokenDescription === undefined ? {} : { tokenDescription: options.tokenDescription }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Service account: ${result.service_account.id}`);
    console.log(`Actor: ${result.service_account.actor_id}`);
    console.log(`Role: ${result.service_account.role ?? "custom"}`);
    console.log(`Token ID: ${result.token.id}`);
    console.log(`Token: ${result.token.value}`);
    if (result.token.expires_at !== undefined) {
      console.log(`Expires: ${result.token.expires_at}`);
    }
    return;
  }
  if (action === "list") {
    const result = await listServiceAccountTokens({
      root,
      ...(options.targetId === undefined && maybeId === undefined ? {} : { id: options.targetId ?? maybeId }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    for (const account of result.service_accounts) {
      console.log(`${account.id}\t${account.actor_id}\t${account.role ?? "custom"}\tactive=${account.active_token_count}\trevoked=${account.revoked_token_count}\texpired=${account.expired_token_count}`);
    }
    return;
  }
  if (action === "inspect") {
    const id = options.targetId ?? maybeId;
    if (id === undefined) {
      throw new Error("Usage: openwiki [--root <path>] auth token inspect <service-account-id> [--json]");
    }
    const result = await inspectServiceAccountToken({ root, id });
    if (options.json) {
      printJson(result);
      return;
    }
    const account = result.service_account;
    console.log(`Service account: ${account.id}`);
    console.log(`Actor: ${account.actor_id}`);
    console.log(`Role: ${account.role ?? "custom"}`);
    console.log(`Scopes: ${account.scopes.join(", ")}`);
    console.log(`Principals: ${account.principals.join(", ") || "(none)"}`);
    console.log(`Tokens: active=${account.active_token_count} revoked=${account.revoked_token_count} expired=${account.expired_token_count}`);
    for (const token of account.tokens) {
      console.log(`${token.id}\t${token.status}\tcreated=${token.created_at ?? ""}\texpires=${token.expires_at ?? ""}`);
    }
    return;
  }
  if (action === "revoke") {
    const id = options.targetId ?? maybeId;
    if (id === undefined) {
      throw new Error("Usage: openwiki [--root <path>] auth token revoke <service-account-id> [--token-id token:id] [--reason text] [--json]");
    }
    const result = await revokeServiceAccountToken({
      root,
      id,
      ...(options.tokenId === undefined ? {} : { tokenId: options.tokenId }),
      ...(options.actor === undefined ? {} : { auditActorId: options.actor }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Revoked ${result.revoked_token_ids.length} token(s) for ${result.service_account.id}`);
    for (const tokenId of result.revoked_token_ids) {
      console.log(tokenId);
    }
    return;
  }
  if (action === "rotate") {
    const id = options.targetId ?? maybeId;
    if (id === undefined) {
      throw new Error("Usage: openwiki [--root <path>] auth token rotate <service-account-id> [--token-id token:id] [--json]");
    }
    const result = await rotateServiceAccountToken({
      root,
      id,
      ...(options.tokenId === undefined ? {} : { tokenId: options.tokenId }),
      ...(options.authTokenProfile === undefined ? {} : { profile: options.authTokenProfile }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.mcpRole === undefined ? {} : { role: options.mcpRole }),
      ...(options.mcpScopes.length === 0 ? {} : { scopes: options.mcpScopes }),
      ...(options.principals.length === 0 ? {} : { principals: options.principals }),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      ...(options.expiresInDays === undefined ? {} : { expiresInDays: options.expiresInDays }),
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.tokenDescription === undefined ? {} : { tokenDescription: options.tokenDescription }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Service account: ${result.service_account.id}`);
    console.log(`Token ID: ${result.token.id}`);
    console.log(`Token: ${result.token.value}`);
    if (result.token.expires_at !== undefined) {
      console.log(`Expires: ${result.token.expires_at}`);
    }
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] auth token create|list|inspect|revoke|rotate");
}

export async function workspaceCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand = "registry"] = args;
  const root = await resolveRoot(options);
  if (subcommand === "connect") {
    const connection = await configureGitRemote(root, {
      ...(options.gitRemote === undefined ? {} : { remote: options.gitRemote }),
      ...(options.gitBranch === undefined ? {} : { branch: options.gitBranch }),
      ...(options.gitRemoteUrl === undefined ? {} : { remote_url: options.gitRemoteUrl }),
      ...(options.credentialRef === undefined ? {} : { credential_ref: options.credentialRef }),
    });
    const registry = await readWorkspaceRegistry(root);
    if (options.json) {
      printJson({ connection, registry });
      return;
    }
    console.log(`Connected ${connection.remote}/${connection.branch}`);
    if (connection.remote_url) {
      console.log(connection.remote_url);
    }
    return;
  }
  if (subcommand !== "registry" && subcommand !== "list" && subcommand !== "current") {
    throw new Error("Usage: openwiki [--root <path>] workspace registry|connect [--json]");
  }
  const registry =
    (await readCurrentPostgresWorkspaceRegistry(root)) ??
    (await readCurrentIndexStoreWorkspaceRegistry(root)) ??
    (await readWorkspaceRegistry(root));
  if (options.json) {
    printJson({ registry });
    return;
  }
  console.log(`Registry source: ${registry.source}`);
  for (const workspace of registry.workspaces) {
    console.log(`${workspace.id}\t${workspace.title}\t${workspace.tenant_id}`);
  }
  for (const repo of registry.repos) {
    console.log(`${repo.id}\t${repo.workspace_id}\t${repo.root_path}`);
  }
}

export async function proposalCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, id] = args;
  const root = await resolveRoot(options);
  if (subcommand === "list") {
    const statuses = options.statuses.map(parseProposalStatus);
    const proposalFilters = {
      ...(statuses.length === 0 ? {} : { statuses }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.targetId === undefined ? {} : { targetId: options.targetId }),
      ...(options.targetPath === undefined ? {} : { targetPath: options.targetPath }),
      ...(options.sectionId === undefined ? {} : { sectionId: options.sectionId }),
      ...(options.updatedAfter === undefined ? {} : { updatedAfter: options.updatedAfter }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    };
    const result = (await listCurrentPostgresProposals(root, proposalFilters)) ?? (await listCurrentIndexStoreProposals(root, proposalFilters)) ?? (await listProposals(root, proposalFilters));
    if (options.json) {
      printJson(result);
      return;
    }
    for (const proposal of result.proposals) {
      console.log(`${proposal.created_at}  ${proposal.status}  ${proposal.id}  ${proposal.title}`);
    }
    return;
  }
  if (subcommand === "read" && id) {
    printJson(await readProposal(root, id));
    return;
  }
  if (subcommand === "detail" && id) {
    printJson(await readProposalDetail(root, id));
    return;
  }
  if (subcommand === "diff" && id) {
    const detail = await readProposalDetail(root, id);
    if (options.json) {
      printJson({ proposal_id: detail.proposal.id, diff: detail.diff });
      return;
    }
    console.log(detail.diff?.body ?? "");
    return;
  }
  if (subcommand === "snapshot" && id) {
    const detail = await readProposalDetail(root, id);
    if (options.json) {
      printJson({ proposal_id: detail.proposal.id, snapshot: detail.snapshot });
      return;
    }
    console.log(detail.snapshot?.body ?? "");
    return;
  }
  if (subcommand === "validation" && id) {
    const detail = await readProposalDetail(root, id);
    printJson({ proposal_id: detail.proposal.id, validation_report: detail.validation_report });
    return;
  }
  if (subcommand === "comment" && id) {
    if (!options.bodyFile) {
      throw new Error(
        "Usage: openwiki [--root <path>] proposal comment <proposal-id> --body-file <path> [--actor actor:user:local] [--json]",
      );
    }
    const result = await commentOnProposal({
      root,
      proposalId: id,
      body: await readFile(path.resolve(options.bodyFile), "utf8"),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Added comment ${result.comment.id}`);
    return;
  }
  if (subcommand === "review" && id) {
    if (!options.decision || !options.rationale) {
      throw new Error(
        "Usage: openwiki [--root <path>] proposal review <proposal-id> --decision accepted|rejected|needs_changes --rationale text [--actor actor:user:local] [--json]",
      );
    }
    const result = await reviewProposal({
      root,
      proposalId: id,
      decision: options.decision,
      rationale: options.rationale,
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Recorded decision ${result.decision.id}`);
    console.log(`Proposal ${result.proposal.id} is ${result.proposal.status}`);
    return;
  }
  if (subcommand === "close" && id) {
    if (!options.rationale) {
      throw new Error(
        "Usage: openwiki [--root <path>] proposal close <proposal-id> --reason text [--superseded-by proposal:id] [--actor actor:user:local] [--json]",
      );
    }
    const result = await closeProposal({
      root,
      proposalId: id,
      rationale: options.rationale,
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.supersededBy === undefined ? {} : { supersededBy: options.supersededBy, resolution: "superseded" }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Closed proposal ${result.proposal.id}`);
    if (result.proposal.superseded_by) {
      console.log(`Superseded by ${result.proposal.superseded_by}`);
    }
    return;
  }
  if (subcommand === "apply" && id) {
    const result = await applyProposal({
      root,
      proposalId: id,
      commit: options.commit,
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.message === undefined ? {} : { message: options.message }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Applied proposal ${result.proposal.id}`);
    for (const appliedPath of result.applied_paths) {
      console.log(appliedPath);
    }
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] proposal list|read|detail|diff|snapshot|validation|comment|review|close|apply ...");
}
