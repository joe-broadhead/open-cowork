import { validateOpenWikiConfig } from "./config.ts";
import {
  type EventRecord,
  type FactRecord,
  isOpenWikiRole,
  type OpenWikiPolicyBundle,
  type ValidationIssue,
  isoNow,
  type TakeRecord,
} from "@openwiki/core";
import { loadRepository, readSourceContent } from "@openwiki/repo";

export { validateOpenWikiConfig, type ValidateOpenWikiConfigOptions } from "./config.ts";
export interface RepositoryValidationReport extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  status: "passed" | "failed";
  checked_at: string;
  issue_count: number;
  issues: ValidationIssue[];
  counts: {
    pages: number;
    sources: number;
    claims: number;
    facts: number;
    takes: number;
    proposals: number;
    comments: number;
    decisions: number;
    events: number;
    runs: number;
  };
}

export async function validateRepository(root: string): Promise<RepositoryValidationReport> {
  const repo = await loadRepository(root);
  const checkedAt = isoNow();
  const issues: ValidationIssue[] = [];
  issues.push(...validateOpenWikiConfig(repo.config, { root: repo.root }));

  checkDuplicateIds(
    [
      ...repo.pages.map((record) => recordRef(record.id, record.path)),
      ...repo.sources.map((record) => recordRef(record.id, record.path)),
      ...repo.claims.map((record) => recordRef(record.id, "claims/claim-index.jsonl")),
      ...repo.facts.map((record) => recordRef(record.id, record.path)),
      ...repo.takes.map((record) => recordRef(record.id, record.path)),
      ...repo.inbox.map((record) => recordRef(record.id, record.path)),
      ...repo.proposals.map((record) => recordRef(record.id, record.path)),
      ...repo.comments.map((record) => recordRef(record.id, record.path)),
      ...repo.decisions.map((record) => recordRef(record.id, record.path)),
      ...repo.events.map((record) => recordRef(record.id, record.path)),
      ...repo.runs.map((record) => recordRef(record.id, record.path)),
    ],
    issues,
  );

  const sourceIds = new Set(repo.sources.map((source) => source.id));
  const claimIds = new Set(repo.claims.map((claim) => claim.id));
  const factIds = new Set(repo.facts.map((fact) => fact.id));
  const takeIds = new Set(repo.takes.map((take) => take.id));
  const pageIds = new Set(repo.pages.map((page) => page.id));
  const proposalIds = new Set(repo.proposals.map((proposal) => proposal.id));
  const runIds = new Set(repo.runs.map((run) => run.id));
  const knownRecordIds = new Set<string>([
    ...pageIds,
    ...sourceIds,
    ...claimIds,
    ...factIds,
    ...takeIds,
    ...repo.inbox.map((item) => item.id),
    ...proposalIds,
    ...repo.comments.map((comment) => comment.id),
    ...repo.decisions.map((decision) => decision.id),
    ...repo.events.map((event) => event.id),
    ...runIds,
  ]);

  for (const page of repo.pages) {
    if (!page.title.trim()) {
      issues.push(validationIssue("error", "page.title.empty", `${page.id} has an empty title`, page.path));
    }
    for (const sourceId of page.source_ids) {
      if (!sourceIds.has(sourceId)) {
        issues.push(validationIssue("error", "page.source.missing", `${page.id} references missing source ${sourceId}`, page.path));
      }
    }
    for (const claimId of page.claim_ids) {
      if (!claimIds.has(claimId)) {
        issues.push(validationIssue("error", "page.claim.missing", `${page.id} references missing claim ${claimId}`, page.path));
      }
    }
  }

  for (const claim of repo.claims) {
    if (!pageIds.has(claim.page_id)) {
      issues.push(
        validationIssue("error", "claim.page.missing", `${claim.id} references missing page ${claim.page_id}`, "claims/claim-index.jsonl"),
      );
    }
    for (const sourceId of claim.source_ids) {
      if (!sourceIds.has(sourceId)) {
        issues.push(
          validationIssue(
            "error",
            "claim.source.missing",
            `${claim.id} references missing source ${sourceId}`,
            "claims/claim-index.jsonl",
          ),
        );
      }
    }
  }

  for (const fact of repo.facts) {
    validateFactRecord(fact, pageIds, sourceIds, claimIds, knownRecordIds, issues);
  }

  for (const take of repo.takes) {
    validateTakeRecord(take, pageIds, sourceIds, claimIds, issues);
  }

  for (const source of repo.sources) {
    const content = await readSourceContent(repo.root, source.id);
    if (content.unavailable_reason === "missing") {
      issues.push(validationIssue("error", "source.content.missing", `${source.id} storage path is missing`, source.path));
    }
    if (content.unavailable_reason === "unsupported_storage") {
      issues.push(validationIssue("error", "source.content.unsupported", `${source.id} uses unsupported storage`, source.path));
    }
    if (content.unavailable_reason === "invalid_storage") {
      issues.push(validationIssue("error", "source.content.invalid_storage", `${source.id} uses invalid storage metadata`, source.path));
    }
    if (content.unavailable_reason === "hash_mismatch") {
      issues.push(validationIssue("error", "source.content.hash_mismatch", `${source.id} content hash does not match`, source.path));
    } else if (content.content?.hash_verified === false) {
      issues.push(validationIssue("error", "source.content.hash_mismatch", `${source.id} content hash does not match`, source.path));
    }
  }

  issues.push(...validatePolicyBundle(repo.policy, { usePolicyFilePaths: true }));

  for (const proposal of repo.proposals) {
    if (proposal.status === "applied" && !proposal.applied_at) {
      issues.push(validationIssue("error", "proposal.applied_at.missing", `${proposal.id} is applied without applied_at`, proposal.path));
    }
    if (proposal.status === "closed" && !proposal.closed_at) {
      issues.push(validationIssue("error", "proposal.closed_at.missing", `${proposal.id} is closed without closed_at`, proposal.path));
    }
    if (proposal.close_resolution === "superseded" && !proposal.superseded_by) {
      issues.push(validationIssue("error", "proposal.superseded_by.missing", `${proposal.id} is superseded without superseded_by`, proposal.path));
    }
    if (proposal.superseded_by && !proposalIds.has(proposal.superseded_by)) {
      issues.push(validationIssue("error", "proposal.superseded_by.missing_record", `${proposal.id} references missing superseding proposal ${proposal.superseded_by}`, proposal.path));
    }
    if (proposal.validation_report_path === undefined) {
      issues.push(validationIssue("warning", "proposal.validation.missing", `${proposal.id} has no validation report`, proposal.path));
    }
  }

  for (const decision of repo.decisions) {
    if (!proposalIds.has(decision.proposal_id)) {
      issues.push(
        validationIssue("error", "decision.proposal.missing", `${decision.id} references missing proposal ${decision.proposal_id}`, decision.path),
      );
    }
  }

  for (const comment of repo.comments) {
    if (!proposalIds.has(comment.proposal_id)) {
      issues.push(
        validationIssue("error", "comment.proposal.missing", `${comment.id} references missing proposal ${comment.proposal_id}`, comment.path),
      );
    }
  }

  for (const event of repo.events) {
    if (event.record_id && event.record_type !== "run" && !isExternalEventRecordReference(event) && !knownRecordIds.has(event.record_id)) {
      issues.push(validationIssue("warning", "event.record.missing", `${event.id} references missing record ${event.record_id}`, event.path));
    }
    if (event.record_id && event.record_type === "run" && !runIds.has(event.record_id)) {
      issues.push(validationIssue("warning", "event.run.missing", `${event.id} references missing run ${event.record_id}`, event.path));
    }
  }

  return {
    id: `validation:${repo.config.workspace_id}:${checkedAt.replace(/[:.]/g, "-")}`,
    workspace_id: repo.config.workspace_id,
    status: issues.some((issue) => issue.severity === "error") ? "failed" : "passed",
    checked_at: checkedAt,
    issue_count: issues.length,
    issues,
    counts: {
      pages: repo.pages.length,
      sources: repo.sources.length,
      claims: repo.claims.length,
      facts: repo.facts.length,
      takes: repo.takes.length,
      proposals: repo.proposals.length,
      comments: repo.comments.length,
      decisions: repo.decisions.length,
      events: repo.events.length,
      runs: repo.runs.length,
    },
  };
}

function validateFactRecord(
  fact: FactRecord,
  pageIds: Set<string>,
  sourceIds: Set<string>,
  claimIds: Set<string>,
  knownRecordIds: Set<string>,
  issues: ValidationIssue[],
): void {
  if (!fact.text.trim()) {
    issues.push(validationIssue("error", "fact.text.empty", `${fact.id} has empty text`, fact.path));
  }
  for (const pageId of fact.page_ids) {
    if (!pageIds.has(pageId)) {
      issues.push(validationIssue("error", "fact.page.missing", `${fact.id} references missing page ${pageId}`, fact.path));
    }
  }
  for (const sourceId of fact.source_ids) {
    if (!sourceIds.has(sourceId)) {
      issues.push(validationIssue("error", "fact.source.missing", `${fact.id} references missing source ${sourceId}`, fact.path));
    }
  }
  for (const claimId of fact.claim_ids) {
    if (!claimIds.has(claimId)) {
      issues.push(validationIssue("error", "fact.claim.missing", `${fact.id} references missing claim ${claimId}`, fact.path));
    }
  }
  for (const subjectId of fact.subject_ids) {
    if (!knownRecordIds.has(subjectId)) {
      issues.push(validationIssue("warning", "fact.subject.missing", `${fact.id} references missing subject ${subjectId}`, fact.path));
    }
  }
  if (fact.status === "forgotten" && fact.valid_to === undefined) {
    issues.push(validationIssue("warning", "fact.valid_to.missing", `${fact.id} is forgotten without valid_to`, fact.path));
  }
}

function validateTakeRecord(
  take: TakeRecord,
  pageIds: Set<string>,
  sourceIds: Set<string>,
  claimIds: Set<string>,
  issues: ValidationIssue[],
): void {
  if (!take.statement.trim()) {
    issues.push(validationIssue("error", "take.statement.empty", `${take.id} has empty statement`, take.path));
  }
  if (take.probability < 0 || take.probability > 1) {
    issues.push(validationIssue("error", "take.probability.invalid", `${take.id} probability must be between 0 and 1`, take.path));
  }
  if (take.status === "resolved" && take.resolution === undefined) {
    issues.push(validationIssue("error", "take.resolution.missing", `${take.id} is resolved without a resolution`, take.path));
  }
  if (take.resolution !== undefined && take.status !== "resolved" && take.status !== "archived") {
    issues.push(validationIssue("warning", "take.status.unresolved_with_resolution", `${take.id} has a resolution but is not resolved`, take.path));
  }
  for (const pageId of take.page_ids) {
    if (!pageIds.has(pageId)) {
      issues.push(validationIssue("error", "take.page.missing", `${take.id} references missing page ${pageId}`, take.path));
    }
  }
  for (const sourceId of take.source_ids) {
    if (!sourceIds.has(sourceId)) {
      issues.push(validationIssue("error", "take.source.missing", `${take.id} references missing source ${sourceId}`, take.path));
    }
  }
  for (const claimId of take.claim_ids) {
    if (!claimIds.has(claimId)) {
      issues.push(validationIssue("error", "take.claim.missing", `${take.id} references missing claim ${claimId}`, take.path));
    }
  }
}

function isExternalEventRecordReference(event: EventRecord): boolean {
  if (event.record_id === undefined) {
    return false;
  }
  if (event.record_id.startsWith("commit:")) {
    return true;
  }
  return event.record_type === "backup" || event.record_type === "backup_destination" || event.record_type === "artifact";
}

export interface ValidatePolicyBundleOptions {
  pathForIssues?: string;
  usePolicyFilePaths?: boolean;
}

export function validatePolicyBundle(policy: OpenWikiPolicyBundle, options: ValidatePolicyBundleOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sectionIds = new Set<string>();
  const issuePath = (file: "sections" | "grants" | "approval-rules"): string => options.usePolicyFilePaths ? `policy/${file}.json` : options.pathForIssues ?? "policy";
  for (const section of policy.sections) {
    if (!section.id || typeof section.id !== "string") {
      issues.push(validationIssue("error", "policy.section.id.missing", "Section is missing an id.", issuePath("sections")));
      continue;
    }
    if (sectionIds.has(section.id)) {
      issues.push(validationIssue("error", "policy.section.id.duplicate", `Duplicate section id '${section.id}'.`, issuePath("sections")));
    }
    sectionIds.add(section.id);
    if (!Array.isArray(section.paths) || section.paths.length === 0) {
      issues.push(validationIssue("error", "policy.section.paths.empty", `${section.id} must include at least one path pattern.`, issuePath("sections")));
    }
    if (section.visibility !== undefined && !["public", "internal", "private"].includes(section.visibility)) {
      issues.push(validationIssue("error", "policy.section.visibility.invalid", `${section.id} has invalid visibility '${String(section.visibility)}'.`, issuePath("sections")));
    }
    if (section.owner_principal !== undefined && typeof section.owner_principal !== "string") {
      issues.push(validationIssue("error", "policy.section.owner.invalid", `${section.id} has an invalid owner principal.`, issuePath("sections")));
    }
    if (section.default_reviewers !== undefined && !Array.isArray(section.default_reviewers)) {
      issues.push(validationIssue("error", "policy.section.default_reviewers.invalid", `${section.id} has invalid default reviewers.`, issuePath("sections")));
    }
  }

  for (const grant of policy.grants) {
    if (!grant.principal || typeof grant.principal !== "string") {
      issues.push(validationIssue("error", "policy.grant.principal.missing", "Grant is missing a principal.", issuePath("grants")));
    }
    if (!grant.section || typeof grant.section !== "string") {
      issues.push(validationIssue("error", "policy.grant.section.missing", "Grant is missing a section.", issuePath("grants")));
    } else if (!sectionIds.has(grant.section)) {
      issues.push(validationIssue("error", "policy.grant.section.unknown", `Grant references unknown section '${grant.section}'.`, issuePath("grants")));
    }
    if (!isOpenWikiRole(grant.role)) {
      issues.push(validationIssue("error", "policy.grant.role.invalid", `Grant for '${grant.principal ?? "unknown"}' has invalid role.`, issuePath("grants")));
    }
  }

  const ruleIds = new Set<string>();
  for (const rule of policy.approval_rules) {
    if (!rule.id || typeof rule.id !== "string") {
      issues.push(validationIssue("error", "policy.approval_rule.id.missing", "Approval rule is missing an id.", issuePath("approval-rules")));
      continue;
    }
    if (ruleIds.has(rule.id)) {
      issues.push(validationIssue("error", "policy.approval_rule.id.duplicate", `Duplicate approval rule id '${rule.id}'.`, issuePath("approval-rules")));
    }
    ruleIds.add(rule.id);
    if (!Array.isArray(rule.paths) || rule.paths.length === 0) {
      issues.push(validationIssue("error", "policy.approval_rule.paths.empty", `${rule.id} must include at least one path pattern.`, issuePath("approval-rules")));
    }
    for (const requirement of rule.required_reviewers ?? []) {
      if (requirement.role !== undefined && !isOpenWikiRole(requirement.role)) {
        issues.push(validationIssue("error", "policy.approval_rule.role.invalid", `${rule.id} has an invalid reviewer role.`, issuePath("approval-rules")));
      }
    }
  }
  if (policy.sections.length > 0 && !policy.sections.some((section) => section.paths.includes("**"))) {
    issues.push(
      validationIssue(
        "warning",
        "policy.catchall.missing",
        "Policy has no catch-all section; unmatched paths will be private by default.",
        options.pathForIssues ?? "policy/sections.json",
      ),
    );
  }
  return issues;
}

function recordRef(id: string, path: string): { id: string; path: string } {
  return { id, path };
}

function checkDuplicateIds(records: Array<{ id: string; path: string }>, issues: ValidationIssue[]): void {
  const seen = new Map<string, string>();
  for (const record of records) {
    const firstPath = seen.get(record.id);
    if (firstPath === undefined) {
      seen.set(record.id, record.path);
      continue;
    }
    issues.push(
      validationIssue(
        "error",
        "record.id.duplicate",
        `${record.id} appears in both ${firstPath} and ${record.path}`,
        record.path,
      ),
    );
  }
}

function validationIssue(
  severity: ValidationIssue["severity"],
  code: string,
  message: string,
  path?: string,
): ValidationIssue {
  return {
    severity,
    code,
    message,
    ...(path === undefined ? {} : { path }),
  };
}
