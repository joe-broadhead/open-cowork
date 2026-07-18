import { promises as fs } from "node:fs";
import { type OpenWikiApprovalRuleRecord, type OpenWikiGrantRecord, type OpenWikiPolicyBundle, type OpenWikiSectionRecord, type ValidationReport, slugify, uniqueStrings } from "@openwiki/core";
import { validatePolicyBundle } from "@openwiki/validation";
import { safeExistingRepoPath } from "./io.ts";
import type { PolicyFileName } from "./types.ts";

export function normalizePolicyFileName(value: PolicyFileName): "sections" | "grants" | "approval-rules" {
  if (value === "sections" || value === "grants" || value === "approval-rules") {
    return value;
  }
  if (value === "approval_rules") {
    return "approval-rules";
  }
  throw new Error(`Unsupported policy file '${value}'`);
}

export function normalizeSectionId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Section policy proposal requires a section id");
  }
  if (trimmed.startsWith("section:")) {
    return trimmed;
  }
  return `section:${slugify(trimmed)}`;
}

export function sectionTitleFromId(sectionId: string): string {
  return sectionId
    .replace(/^section:/, "")
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Untitled Section";
}

export function approvalRuleIdForSection(sectionId: string): string {
  return `approval:${sectionId.replace(/^section:/, "")}`;
}

export function upsertSection(sections: OpenWikiSectionRecord[], next: OpenWikiSectionRecord): OpenWikiSectionRecord[] {
  const updated = sections.map((section) => (section.id === next.id ? next : section));
  return updated.some((section) => section.id === next.id) ? updated : [...updated, next];
}

export function mergePolicyGrants(
  grants: OpenWikiGrantRecord[],
  sectionId: string,
  principalsByRole: Partial<Record<OpenWikiGrantRecord["role"], string[]>>,
  options: { replaceSectionGrants?: boolean } = {},
): OpenWikiGrantRecord[] {
  const replaceRoles = new Set(Object.keys(principalsByRole) as OpenWikiGrantRecord["role"][]);
  const next = options.replaceSectionGrants === true ? grants.filter((grant) => grant.section !== sectionId || !replaceRoles.has(grant.role)) : [...grants];
  const seen = new Set(next.map((grant) => `${grant.principal}\0${grant.section}\0${grant.role}`));
  for (const [role, principals] of Object.entries(principalsByRole) as Array<[OpenWikiGrantRecord["role"], string[] | undefined]>) {
    for (const principal of uniqueStrings(principals ?? [], { trim: true, omitEmpty: true })) {
      const key = `${principal}\0${sectionId}\0${role}`;
      if (!seen.has(key)) {
        next.push({ principal, section: sectionId, role });
        seen.add(key);
      }
    }
  }
  return next;
}

export function upsertApprovalRule(
  rules: OpenWikiApprovalRuleRecord[],
  next: OpenWikiApprovalRuleRecord,
): OpenWikiApprovalRuleRecord[] {
  const updated = rules.map((rule) => (rule.id === next.id ? next : rule));
  return updated.some((rule) => rule.id === next.id) ? updated : [...updated, next];
}

export function policyFilePath(policyFile: "sections" | "grants" | "approval-rules"): string {
  return `policy/${policyFile}.json`;
}

export function policyFileBodyFromBundle(policy: OpenWikiPolicyBundle, policyFile: "sections" | "grants" | "approval-rules"): string {
  if (policyFile === "sections") {
    return `${JSON.stringify(policy.sections, null, 2)}\n`;
  }
  if (policyFile === "grants") {
    return `${JSON.stringify(policy.grants, null, 2)}\n`;
  }
  return `${JSON.stringify(policy.approval_rules, null, 2)}\n`;
}

export async function readPolicyFileBody(root: string, targetPath: string): Promise<string> {
  try {
    return await fs.readFile(await safeExistingRepoPath(root, targetPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "[]\n";
    }
    throw error;
  }
}

export function normalizePolicyFileBody(policyFile: "sections" | "grants" | "approval-rules", body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for policy/${policyFile}.json: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`policy/${policyFile}.json must be a JSON array`);
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function policyBundleWithProposedFile(
  current: OpenWikiPolicyBundle,
  policyFile: "sections" | "grants" | "approval-rules",
  parsed: unknown,
): OpenWikiPolicyBundle {
  if (!Array.isArray(parsed)) {
    throw new Error(`policy/${policyFile}.json must be a JSON array`);
  }
  if (policyFile === "sections") {
    return { ...current, sections: parsed as OpenWikiSectionRecord[] };
  }
  if (policyFile === "grants") {
    return { ...current, grants: parsed as OpenWikiGrantRecord[] };
  }
  return { ...current, approval_rules: parsed as OpenWikiApprovalRuleRecord[] };
}

export function validatePolicyProposal(
  proposalId: string,
  targetPath: string,
  policy: OpenWikiPolicyBundle,
  checkedAt: string,
): ValidationReport {
  const issues = validatePolicyBundle(policy, { pathForIssues: targetPath });
  return {
    id: `${proposalId}:validation`,
    proposal_id: proposalId,
    status: issues.some((issue) => issue.severity === "error") ? "failed" : "passed",
    checked_at: checkedAt,
    issues,
  };
}
