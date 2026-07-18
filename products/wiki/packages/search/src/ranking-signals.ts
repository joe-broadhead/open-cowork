import type { IndexRecord } from "./records.ts";
import type { ClaimRecord, DecisionRecord, ProposalRecord, SourceRecord } from "@openwiki/core";
import type { RankingSignals } from "./types.ts";

export function rankingSignalsForRecord(
  record: IndexRecord,
  sources: SourceRecord[],
  claims: ClaimRecord[],
  proposals: ProposalRecord[],
  decisions: DecisionRecord[],
): RankingSignals {
  return {
    source_reliability: sourceReliabilitySignal(record, sources),
    citation_density: citationDensitySignal(record),
    claim_confidence: claimConfidenceSignal(record, claims),
    decision_support: decisionSupportSignal(record, proposals, decisions),
  };
}

export function rankingSignalMultiplier(signals: RankingSignals): number {
  const multiplied = Object.values(signals).reduce((score, value) => score * value, 1);
  return Math.min(Math.max(multiplied, 0.75), 1.35);
}

export function supportScore(signals: RankingSignals): number {
  return signals.source_reliability + signals.citation_density + signals.claim_confidence + signals.decision_support;
}

function sourceReliabilitySignal(record: IndexRecord, sources: SourceRecord[]): number {
  if (record.source_ids.length === 0) {
    return 1;
  }
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const values = record.source_ids.map((sourceId) => sourceReliability(sourceById.get(sourceId)));
  return roundSignal(average(values));
}

function sourceReliability(source: SourceRecord | undefined): number {
  const reliability = stringValue(source?.trust?.reliability);
  if (reliability === "high") {
    return 1.06;
  }
  if (reliability === "low") {
    return 0.94;
  }
  return 1;
}

function citationDensitySignal(record: IndexRecord): number {
  if (record.source_ids.length === 0) {
    return 1;
  }
  return roundSignal(1 + Math.min(new Set(record.source_ids).size, 5) * 0.012);
}

function claimConfidenceSignal(record: IndexRecord, claims: ClaimRecord[]): number {
  const relevantClaims =
    record.type === "claim" ? claims.filter((claim) => claim.id === record.id) : claims.filter((claim) => claim.page_id === record.id);
  if (relevantClaims.length === 0) {
    return 1;
  }
  return roundSignal(average(relevantClaims.map(claimSignal)));
}

function claimSignal(claim: ClaimRecord): number {
  const confidence =
    claim.confidence === "high" ? 1.05 : claim.confidence === "low" ? 0.95 : 1;
  const status =
    claim.status === "disputed" ? 0.92 : claim.status === "stale" ? 0.97 : claim.status === "archived" ? 0.96 : 1;
  return confidence * status;
}

function decisionSupportSignal(
  record: IndexRecord,
  proposals: ProposalRecord[],
  decisions: DecisionRecord[],
): number {
  if (record.type === "decision") {
    const decision = decisions.find((candidate) => candidate.id === record.id);
    return decision ? roundSignal(decisionSignal(decision)) : 1;
  }

  const relatedProposalIds = new Set<string>();
  if (record.type === "proposal") {
    relatedProposalIds.add(record.id);
  }
  for (const proposal of proposals) {
    if (proposal.target_ids.includes(record.id)) {
      relatedProposalIds.add(proposal.id);
    }
  }
  if (relatedProposalIds.size === 0) {
    return 1;
  }

  const relatedDecisions = decisions.filter((decision) => relatedProposalIds.has(decision.proposal_id));
  if (relatedDecisions.length === 0) {
    return 1;
  }
  return roundSignal(average(relatedDecisions.map(decisionSignal)));
}

function decisionSignal(decision: DecisionRecord): number {
  if (decision.decision === "accepted") {
    return 1.04;
  }
  if (decision.decision === "rejected") {
    return 0.95;
  }
  return 0.98;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 1;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

function roundSignal(value: number): number {
  return Number(value.toFixed(4));
}
