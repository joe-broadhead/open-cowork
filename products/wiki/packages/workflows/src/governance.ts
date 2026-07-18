import path from "node:path";
import { isoNow, slugify, type PageRecord } from "@openwiki/core";
import { graphOrphans, loadRepository, type LoadedOpenWikiRepo } from "@openwiki/repo";
import { canReadPathExpression, canReadRecordId, type PolicyContext } from "@openwiki/policy";

export type GovernanceDetectorKind = "stale_claim" | "missing_source" | "broken_link" | "orphan_page";

export interface GovernanceDetectorFinding {
  id: string;
  detector: GovernanceDetectorKind;
  severity: "info" | "warning" | "error";
  record_id: string;
  record_type: "page" | "claim";
  title: string;
  message: string;
  path?: string;
  source_id?: string;
  target?: string;
  status?: string;
  reasons?: string[];
  suggested_actions: string[];
}

export interface GovernanceDetectorReport {
  id: string;
  workspace_id: string;
  generated_at: string;
  status: "passed" | "attention";
  finding_count: number;
  counts: Record<GovernanceDetectorKind, number>;
  findings: GovernanceDetectorFinding[];
}

export interface RunGovernanceDetectorsInput {
  root: string;
  detectors?: GovernanceDetectorKind[];
  staleAfterDays?: number;
}

export async function runGovernanceDetectors(input: RunGovernanceDetectorsInput): Promise<GovernanceDetectorReport> {
  const repo = await loadRepository(input.root);
  const generatedAt = isoNow();
  const enabled = new Set<GovernanceDetectorKind>(
    input.detectors && input.detectors.length > 0
      ? input.detectors
      : ["stale_claim", "missing_source", "broken_link", "orphan_page"],
  );
  const findings: GovernanceDetectorFinding[] = [];

  if (enabled.has("stale_claim")) {
    findings.push(...detectStaleClaims(repo, input.staleAfterDays ?? 180, generatedAt));
  }
  if (enabled.has("missing_source")) {
    findings.push(...detectMissingSources(repo));
  }
  if (enabled.has("broken_link")) {
    findings.push(...detectBrokenLinks(repo));
  }
  if (enabled.has("orphan_page")) {
    findings.push(...(await detectOrphanPages(repo.root)));
  }

  findings.sort(
    (left, right) =>
      left.detector.localeCompare(right.detector) ||
      left.record_id.localeCompare(right.record_id) ||
      left.id.localeCompare(right.id),
  );

  return governanceDetectorReport(repo.config.workspace_id, generatedAt, findings);
}

export function filterGovernanceDetectorReportByVisibility(
  repo: LoadedOpenWikiRepo,
  context: PolicyContext,
  report: GovernanceDetectorReport,
): GovernanceDetectorReport {
  return governanceDetectorReport(
    report.workspace_id,
    report.generated_at,
    report.findings.filter((finding) => governanceFindingVisible(repo, context, finding)),
  );
}

function detectStaleClaims(repo: LoadedOpenWikiRepo, staleAfterDays: number, generatedAt: string): GovernanceDetectorFinding[] {
  const pageById = new Map(repo.pages.map((page) => [page.id, page]));
  const generatedTime = Date.parse(generatedAt);
  const maxAgeMs = Math.max(staleAfterDays, 1) * 24 * 60 * 60 * 1000;
  const findings: GovernanceDetectorFinding[] = [];
  for (const claim of repo.claims) {
    const page = pageById.get(claim.page_id);
    const reasons: string[] = [];
    if (claim.status === "stale") {
      reasons.push("claim_status_stale");
    }
    if (claim.status === "disputed") {
      reasons.push("claim_status_disputed");
    }
    if (claim.last_verified_at !== undefined && Number.isFinite(generatedTime)) {
      const verifiedAt = Date.parse(claim.last_verified_at);
      if (Number.isFinite(verifiedAt) && generatedTime - verifiedAt > maxAgeMs) {
        reasons.push("verification_age_exceeded");
      }
    }
    if (reasons.length === 0) {
      continue;
    }
    findings.push({
      id: governanceFindingId("stale_claim", claim.id, reasons.join("-")),
      detector: "stale_claim",
      severity: claim.status === "disputed" ? "error" : "warning",
      record_id: claim.id,
      record_type: "claim",
      title: claim.text,
      message: `${claim.id} needs claim review: ${reasons.join(", ")}.`,
      path: "claims/claim-index.jsonl",
      status: claim.status,
      reasons,
      suggested_actions: [
        "Trace the claim to supporting sources.",
        "Refresh or replace stale evidence.",
        "Create a proposal if the claim text or linked sources changed.",
      ],
      ...(page === undefined ? {} : { target: page.id }),
    });
  }
  return findings;
}

function detectMissingSources(repo: LoadedOpenWikiRepo): GovernanceDetectorFinding[] {
  const sourceIds = new Set(repo.sources.map((source) => source.id));
  const pageById = new Map(repo.pages.map((page) => [page.id, page]));
  const findings: GovernanceDetectorFinding[] = [];
  for (const page of repo.pages) {
    if (page.source_ids.length === 0) {
      findings.push({
        id: governanceFindingId("missing_source", page.id, "empty"),
        detector: "missing_source",
        severity: "warning",
        record_id: page.id,
        record_type: "page",
        title: page.title,
        message: `${page.id} has no linked sources.`,
        path: page.path,
        reasons: ["page_has_no_sources"],
        suggested_actions: [
          "Find or ingest a source that supports this page.",
          "Create a source proposal and link the source ID from page frontmatter.",
        ],
      });
    }
    for (const sourceId of page.source_ids) {
      if (!sourceIds.has(sourceId)) {
        findings.push({
          id: governanceFindingId("missing_source", page.id, sourceId),
          detector: "missing_source",
          severity: "error",
          record_id: page.id,
          record_type: "page",
          title: page.title,
          message: `${page.id} references missing source ${sourceId}.`,
          path: page.path,
          source_id: sourceId,
          reasons: ["page_references_missing_source"],
          suggested_actions: [
            "Restore the missing source manifest or remove the stale source ID.",
            "Run repository lint after the source reference is fixed.",
          ],
        });
      }
    }
  }
  for (const claim of repo.claims) {
    const page = pageById.get(claim.page_id);
    if (claim.source_ids.length === 0) {
      findings.push({
        id: governanceFindingId("missing_source", claim.id, "empty"),
        detector: "missing_source",
        severity: "warning",
        record_id: claim.id,
        record_type: "claim",
        title: claim.text,
        message: `${claim.id} has no linked sources.`,
        path: "claims/claim-index.jsonl",
        reasons: ["claim_has_no_sources"],
        suggested_actions: [
          "Trace the claim to evidence.",
          "Link at least one source ID or archive the unsupported claim.",
        ],
        ...(page === undefined ? {} : { target: page.id }),
      });
    }
    for (const sourceId of claim.source_ids) {
      if (!sourceIds.has(sourceId)) {
        findings.push({
          id: governanceFindingId("missing_source", claim.id, sourceId),
          detector: "missing_source",
          severity: "error",
          record_id: claim.id,
          record_type: "claim",
          title: claim.text,
          message: `${claim.id} references missing source ${sourceId}.`,
          path: "claims/claim-index.jsonl",
          source_id: sourceId,
          reasons: ["claim_references_missing_source"],
          suggested_actions: [
            "Restore the missing source manifest or update the claim source IDs.",
            "Run repository lint after the source reference is fixed.",
          ],
          ...(page === undefined ? {} : { target: page.id }),
        });
      }
    }
  }
  return findings;
}

function detectBrokenLinks(repo: LoadedOpenWikiRepo): GovernanceDetectorFinding[] {
  const findings: GovernanceDetectorFinding[] = [];
  for (const page of repo.pages) {
    for (const link of internalPageLinks(page.body)) {
      if (resolveInternalPageLink(repo, page, link.target) !== undefined) {
        continue;
      }
      findings.push({
        id: governanceFindingId("broken_link", page.id, link.target),
        detector: "broken_link",
        severity: "warning",
        record_id: page.id,
        record_type: "page",
        title: page.title,
        message: `${page.id} links to missing page target ${link.target}.`,
        path: page.path,
        target: link.target,
        reasons: ["internal_page_link_unresolved"],
        suggested_actions: [
          "Create the linked page, correct the target, or remove the stale link.",
          "Use graph neighbors to verify the page link after editing.",
        ],
      });
    }
  }
  return findings;
}

async function detectOrphanPages(root: string): Promise<GovernanceDetectorFinding[]> {
  const response = await graphOrphans(root);
  return response.pages.map((page) => ({
    id: governanceFindingId("orphan_page", page.id, "no-page-links"),
    detector: "orphan_page",
    severity: "info",
    record_id: page.id,
    record_type: "page",
    title: page.title,
    message: `${page.id} has no page-to-page graph links.`,
    ...(page.path === undefined ? {} : { path: page.path }),
    reasons: ["no_page_to_page_edges"],
    suggested_actions: [
      "Link this page from a related page or topic hub.",
      "Add an outgoing link to a relevant page if the page should be discoverable through the graph.",
    ],
  }));
}

function governanceDetectorReport(
  workspaceId: string,
  generatedAt: string,
  findings: GovernanceDetectorFinding[],
): GovernanceDetectorReport {
  return {
    id: `governance:${workspaceId}:${generatedAt.replace(/[:.]/g, "-")}`,
    workspace_id: workspaceId,
    generated_at: generatedAt,
    status: findings.length === 0 ? "passed" : "attention",
    finding_count: findings.length,
    counts: {
      stale_claim: findings.filter((finding) => finding.detector === "stale_claim").length,
      missing_source: findings.filter((finding) => finding.detector === "missing_source").length,
      broken_link: findings.filter((finding) => finding.detector === "broken_link").length,
      orphan_page: findings.filter((finding) => finding.detector === "orphan_page").length,
    },
    findings,
  };
}

function governanceFindingVisible(
  repo: LoadedOpenWikiRepo,
  context: PolicyContext,
  finding: GovernanceDetectorFinding,
): boolean {
  if (canReadRecordId(repo, context, finding.record_id)) {
    return true;
  }
  return finding.path !== undefined && canReadPathExpression(repo.policy, context, finding.path);
}

function governanceFindingId(detector: GovernanceDetectorKind, recordId: string, detail: string): string {
  return `finding:${detector}:${slugify(recordId)}:${slugify(detail).slice(0, 80)}`;
}

function internalPageLinks(body: string): Array<{ target: string }> {
  const links: Array<{ target: string }> = [];
  const markdownLink = /(!?)\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of body.matchAll(markdownLink)) {
    if (match[1] === "!") {
      continue;
    }
    const target = normalizeInternalLinkTarget(match[2] ?? "");
    if (target !== undefined) {
      links.push({ target });
    }
  }
  const wikiLink = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?]]/g;
  for (const match of body.matchAll(wikiLink)) {
    const target = normalizeInternalLinkTarget(match[1] ?? "");
    if (target !== undefined) {
      links.push({ target });
    }
  }
  return links.filter((link, index, array) => array.findIndex((candidate) => candidate.target === link.target) === index);
}

function normalizeInternalLinkTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return undefined;
  }
  const withoutFragment = trimmed.split("#")[0]?.split("?")[0]?.trim() ?? "";
  if (!withoutFragment) {
    return undefined;
  }
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

function resolveInternalPageLink(repo: LoadedOpenWikiRepo, page: PageRecord, target: string): PageRecord | undefined {
  if (target.startsWith("page:")) {
    return repo.pages.find((candidate) => candidate.id === target);
  }
  const wikiTarget = resolveWikiPageLink(repo, target);
  if (wikiTarget !== undefined) {
    return wikiTarget;
  }
  const baseDir = path.posix.dirname(page.path);
  const normalized = path.posix.normalize(target.startsWith("/") ? target.slice(1) : path.posix.join(baseDir, target));
  if (normalized.startsWith("../") || normalized === "..") {
    return undefined;
  }
  const candidates = [normalized, normalized.endsWith(".md") ? normalized : normalized + ".md"];
  return repo.pages.find((candidate) => candidates.includes(candidate.path));
}

function resolveWikiPageLink(repo: LoadedOpenWikiRepo, target: string): PageRecord | undefined {
  const normalized = slugify(target);
  return repo.pages.find((page) => {
    const basename = path.posix.basename(page.path, path.posix.extname(page.path));
    const idTail = page.id.split(":").at(-1) ?? page.id;
    return slugify(page.title) === normalized || slugify(basename) === normalized || slugify(idTail) === normalized;
  });
}
