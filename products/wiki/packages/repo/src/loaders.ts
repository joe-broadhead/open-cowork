import { promises as fs } from "node:fs";
import path from "node:path";
import {
  openWikiWorkspaceConfigFromUnknown,
  openWikiRepoRelativePath,
  type ClaimRecord,
  type DecisionRecord,
  type EventRecord,
  type FactRecord,
  type InboxItemRecord,
  type OpenWikiApprovalRuleRecord,
  type OpenWikiConfig,
  type OpenWikiGrantRecord,
  type OpenWikiPolicyBundle,
  type OpenWikiSectionRecord,
  type PageRecord,
  type ProposalCommentRecord,
  type ProposalRecord,
  type RunRecord,
  type SourceRecord,
  type TakeRecord,
} from "@openwiki/core";
import { parseMarkdownWithFrontmatter, parseYamlSubset } from "./frontmatter.ts";
import { defaultApprovalRules, defaultPolicyGrants, defaultPolicySections } from "./templates.ts";
import { listRepoFiles, objectValue, readRepoTextFileIfExists } from "./io.ts";
import {
  normalizeClaim,
  normalizeDecision,
  normalizeEvent,
  normalizeFact,
  normalizeInboxItem,
  normalizeProposal,
  normalizeProposalComment,
  normalizeRun,
  normalizeTake,
  pageFromMarkdown,
  sourceFromManifest,
} from "./normalizers.ts";

export async function readConfig(root: string): Promise<OpenWikiConfig> {
  const raw = await readRepoTextFileIfExists(root, "openwiki.json");
  if (raw === undefined) {
    throw new Error("Missing OpenWiki config: openwiki.json");
  }
  return openWikiWorkspaceConfigFromUnknown(JSON.parse(raw) as unknown, "openwiki.json");
}

export async function loadPages(root: string): Promise<PageRecord[]> {
  const pages: PageRecord[] = [];
  const files = await listRepoFiles(root, "wiki");
  for (const file of files.filter((candidate) => candidate.endsWith(".md"))) {
    const relativePath = openWikiRepoRelativePath(root, file);
    const raw = await fs.readFile(file, "utf8");
    const parsed = parseMarkdownWithFrontmatter(raw);
    pages.push(pageFromMarkdown(relativePath, parsed.frontmatter, parsed.body));
  }
  pages.sort((left, right) => left.id.localeCompare(right.id));
  return pages;
}

export async function loadSources(root: string): Promise<SourceRecord[]> {
  const sources: SourceRecord[] = [];
  const files = await listRepoFiles(root, "sources/manifests");
  for (const file of files.filter((candidate) => candidate.endsWith(".yaml") || candidate.endsWith(".yml"))) {
    const relativePath = openWikiRepoRelativePath(root, file);
    const raw = await fs.readFile(file, "utf8");
    const parsed = parseYamlSubset(raw);
    sources.push(sourceFromManifest(relativePath, parsed));
  }
  sources.sort((left, right) => left.id.localeCompare(right.id));
  return sources;
}

export async function loadClaims(root: string): Promise<ClaimRecord[]> {
  const raw = await readRepoTextFileIfExists(root, "claims/claim-index.jsonl");
  if (raw === undefined) {
    return [];
  }
  const claims = parseJsonlRecords(raw, "claims/claim-index.jsonl", (value) => normalizeClaim(value as Partial<ClaimRecord>));
  claims.sort((left, right) => left.id.localeCompare(right.id));
  return claims;
}

export async function loadFacts(root: string): Promise<FactRecord[]> {
  const raw = await readRepoTextFileIfExists(root, "facts/facts.jsonl");
  if (raw === undefined) {
    return [];
  }
  const facts = parseJsonlRecords(raw, "facts/facts.jsonl", (value) => normalizeFact(value as Partial<FactRecord>));
  facts.sort((left, right) => left.id.localeCompare(right.id));
  return facts;
}

export async function loadTakes(root: string): Promise<TakeRecord[]> {
  const raw = await readRepoTextFileIfExists(root, "takes/takes.jsonl");
  if (raw === undefined) {
    return [];
  }
  const takes = parseJsonlRecords(raw, "takes/takes.jsonl", (value) => normalizeTake(value as Partial<TakeRecord>));
  takes.sort((left, right) => left.id.localeCompare(right.id));
  return takes;
}

export async function loadInboxItems(root: string): Promise<InboxItemRecord[]> {
  const raw = await readRepoTextFileIfExists(root, "inbox/items.jsonl");
  if (raw === undefined) {
    return [];
  }
  const inbox = parseJsonlRecords(raw, "inbox/items.jsonl", (value) => normalizeInboxItem(value as Partial<InboxItemRecord>));
  inbox.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id));
  return inbox;
}

export async function loadProposals(root: string): Promise<ProposalRecord[]> {
  const files = await listRepoFiles(root, "proposals");
  const proposals: ProposalRecord[] = [];
  for (const file of files.filter(
    (candidate) =>
      path.dirname(candidate) === path.join(path.resolve(root), "proposals") && (candidate.endsWith(".yaml") || candidate.endsWith(".yml")),
  )) {
    const relativePath = openWikiRepoRelativePath(root, file);
    const raw = await fs.readFile(file, "utf8");
    proposals.push(normalizeProposal(relativePath, parseYamlSubset(raw)));
  }
  proposals.sort((left, right) => left.id.localeCompare(right.id));
  return proposals;
}

export async function loadProposalComments(root: string): Promise<ProposalCommentRecord[]> {
  const raw = await readRepoTextFileIfExists(root, "proposals/comments.jsonl");
  if (raw === undefined) {
    return [];
  }
  const comments = parseJsonlRecords(raw, "proposals/comments.jsonl", (value) => normalizeProposalComment(value as Partial<ProposalCommentRecord>));
  comments.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
  return comments;
}

export async function loadDecisions(root: string): Promise<DecisionRecord[]> {
  const files = await listRepoFiles(root, "decisions");
  const decisions: DecisionRecord[] = [];
  for (const file of files.filter((candidate) => candidate.endsWith(".yaml") || candidate.endsWith(".yml"))) {
    const relativePath = openWikiRepoRelativePath(root, file);
    const raw = await fs.readFile(file, "utf8");
    decisions.push(normalizeDecision(relativePath, parseYamlSubset(raw)));
  }
  decisions.sort((left, right) => left.id.localeCompare(right.id));
  return decisions;
}

export async function loadEvents(root: string): Promise<EventRecord[]> {
  const raw = await readRepoTextFileIfExists(root, "events/events.jsonl");
  if (raw === undefined) {
    return [];
  }
  const events = parseJsonlRecords(raw, "events/events.jsonl", (value) => normalizeEvent(value as Partial<EventRecord>));
  events.sort((left, right) => right.occurred_at.localeCompare(left.occurred_at) || right.id.localeCompare(left.id));
  return events;
}

export async function loadRuns(root: string): Promise<RunRecord[]> {
  const raw = await readRepoTextFileIfExists(root, "runs/runs.jsonl");
  if (raw === undefined) {
    return [];
  }
  const runs = parseJsonlRecords(raw, "runs/runs.jsonl", (value) => normalizeRun(value as Partial<RunRecord>));
  runs.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
  return runs;
}

function parseJsonlRecords<T>(raw: string, repoPath: string, normalize: (value: unknown) => T): T[] {
  const records: T[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line) {
      continue;
    }
    try {
      records.push(normalize(JSON.parse(line) as unknown));
    } catch (error) {
      const hint = line.startsWith("<<<<<<<") || line.startsWith("=======") || line.startsWith(">>>>>>>")
        ? " This looks like an unresolved Git conflict marker."
        : "";
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSONL record in ${repoPath} at line ${index + 1}: ${message}.${hint}`);
    }
  }
  return records;
}

export async function loadPolicy(root: string): Promise<OpenWikiPolicyBundle> {
  const [sections, grants, approvalRules] = await Promise.all([
    readPolicyJson<Array<Partial<OpenWikiSectionRecord>>>(root, "policy/sections.json", defaultPolicySections(), policyObjectArray),
    readPolicyJson<Array<Partial<OpenWikiGrantRecord>>>(root, "policy/grants.json", defaultPolicyGrants(), policyObjectArray),
    readPolicyJson<Array<Partial<OpenWikiApprovalRuleRecord>>>(root, "policy/approval-rules.json", defaultApprovalRules(), policyObjectArray),
  ]);
  return {
    sections: sections.map(normalizePolicySection).filter((section) => section.paths.length > 0),
    grants: grants.map(normalizePolicyGrant).filter((grant) => Boolean(grant.principal && grant.section)),
    approval_rules: approvalRules.map(normalizeApprovalRule).filter((rule) => rule.paths.length > 0),
  };
}

async function readPolicyJson<T>(root: string, repoPath: string, fallback: T, parse: (value: unknown) => T): Promise<T> {
  const raw = await readRepoTextFileIfExists(root, repoPath);
  if (raw === undefined) {
    return fallback;
  }
  return parse(JSON.parse(raw) as unknown);
}

function policyObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

function normalizePolicySection(input: Partial<OpenWikiSectionRecord>): OpenWikiSectionRecord {
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id : "section:all",
    title: typeof input.title === "string" && input.title.trim() ? input.title : "Untitled Section",
    paths: Array.isArray(input.paths) ? input.paths.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [],
    visibility: input.visibility === "internal" || input.visibility === "private" ? input.visibility : "public",
    ...(typeof input.owner_principal === "string" && input.owner_principal.trim() ? { owner_principal: input.owner_principal } : {}),
    ...(Array.isArray(input.default_reviewers)
      ? { default_reviewers: input.default_reviewers.filter((value): value is string => typeof value === "string" && value.trim().length > 0) }
      : {}),
    ...(typeof input.description === "string" ? { description: input.description } : {}),
  };
}

function normalizePolicyGrant(input: Partial<OpenWikiGrantRecord>): OpenWikiGrantRecord {
  return {
    principal: typeof input.principal === "string" ? input.principal : "",
    section: typeof input.section === "string" ? input.section : "",
    role: isPolicyRole(input.role) ? input.role : "viewer",
  };
}

function normalizeApprovalRule(input: Partial<OpenWikiApprovalRuleRecord>): OpenWikiApprovalRuleRecord {
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id : "approval-rule:default",
    paths: Array.isArray(input.paths) ? input.paths.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [],
    required_reviewers: Array.isArray(input.required_reviewers)
      ? input.required_reviewers
          .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
          .map((value) => ({
            ...(typeof value.principal === "string" ? { principal: value.principal } : {}),
            ...(isPolicyRole(value.role) ? { role: value.role } : {}),
          }))
      : [],
    ...(typeof input.require_separate_actor === "boolean" ? { require_separate_actor: input.require_separate_actor } : {}),
  };
}

function isPolicyRole(value: unknown): value is OpenWikiGrantRecord["role"] {
  return (
    value === "viewer" ||
    value === "contributor" ||
    value === "researcher" ||
    value === "reviewer" ||
    value === "maintainer" ||
    value === "admin" ||
    value === "agent"
  );
}
