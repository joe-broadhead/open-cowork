import { type DecisionRecord, type ProposalRecord, slugify } from "@openwiki/core";

export function renderProposalYaml(proposal: ProposalRecord): string {
  const lines = [
    `id: ${proposal.id}`,
    `uri: ${proposal.uri}`,
    "type: proposal",
    `title: ${yamlScalar(proposal.title)}`,
    `status: ${proposal.status}`,
    `actor_id: ${proposal.actor_id}`,
    "target_ids:",
    ...proposal.target_ids.map((targetId) => `  - ${targetId}`),
    ...(proposal.target_path ? [`target_path: ${proposal.target_path}`] : []),
    ...(proposal.base_commit ? [`base_commit: ${yamlScalar(proposal.base_commit)}`] : []),
    "diff:",
    `  format: ${proposal.diff.format}`,
    `  path: ${proposal.diff.path}`,
    ...(proposal.snapshot_path ? [`snapshot_path: ${proposal.snapshot_path}`] : []),
    ...(proposal.snapshot_paths
      ? ["snapshot_paths:", ...Object.entries(proposal.snapshot_paths).map(([key, value]) => `  ${key}: ${value}`)]
      : []),
    ...(proposal.validation_report_path ? [`validation_report_path: ${proposal.validation_report_path}`] : []),
    ...(proposal.rationale ? [`rationale: ${yamlScalar(proposal.rationale)}`] : []),
    `created_at: ${proposal.created_at}`,
    ...(proposal.applied_at ? [`applied_at: ${proposal.applied_at}`] : []),
    ...(proposal.applied_commit ? [`applied_commit: ${yamlScalar(proposal.applied_commit)}`] : []),
    ...(proposal.closed_at ? [`closed_at: ${proposal.closed_at}`] : []),
    ...(proposal.closed_by ? [`closed_by: ${proposal.closed_by}`] : []),
    ...(proposal.close_resolution ? [`close_resolution: ${proposal.close_resolution}`] : []),
    ...(proposal.close_rationale ? [`close_rationale: ${yamlScalar(proposal.close_rationale)}`] : []),
    ...(proposal.superseded_by ? [`superseded_by: ${proposal.superseded_by}`] : []),
    "",
  ];
  return `${lines.join("\n")}`;
}

export function pagePathFor(pageType: string, title: string): string {
  return `wiki/${pluralizePageType(pageType)}/${slugify(title)}.md`;
}

function pluralizePageType(pageType: string): string {
  if (pageType === "entity") {
    return "entities";
  }
  if (pageType === "person") {
    return "people";
  }
  if (pageType.endsWith("s")) {
    return pageType;
  }
  return `${pageType}s`;
}

export function renderDecisionYaml(decision: DecisionRecord): string {
  const lines = [
    `id: ${decision.id}`,
    `uri: ${decision.uri}`,
    "type: decision",
    `proposal_id: ${decision.proposal_id}`,
    `decision: ${decision.decision}`,
    `actor_id: ${decision.actor_id}`,
    `rationale: ${yamlScalar(decision.rationale)}`,
    ...(decision.commit ? [`commit: ${decision.commit}`] : []),
    `decided_at: ${decision.decided_at}`,
    "",
  ];
  return `${lines.join("\n")}`;
}

export function unifiedDiff(filePath: string, oldText: string, newText: string): string {
  const oldLines = oldText.replace(/\n$/, "").split("\n");
  const newLines = newText.replace(/\n$/, "").split("\n");
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export function nextDailySequence(ids: string[], kind: "proposal" | "decision" | "source" | "fact" | "take", iso: string): number {
  const prefix = `${kind}:${iso.slice(0, 10)}-`;
  const numbers = ids
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((value) => Number.isInteger(value));
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

export function dateSequenceId(kind: "proposal" | "decision" | "source" | "fact" | "take", iso: string, sequence: number): string {
  return `${kind}:${iso.slice(0, 10)}-${String(sequence).padStart(3, "0")}`;
}

export function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value) && !isYamlTypedPlainScalar(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function isYamlTypedPlainScalar(value: string): boolean {
  return /^(?:true|false|null|~|-?\d+(?:\.\d+)?)$/i.test(value.trim());
}
