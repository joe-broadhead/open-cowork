import type { IndexRecord } from "./records.ts";
import type { SourceRecord } from "@openwiki/core";
import { publicPathAllowed } from "@openwiki/policy";
import { type LoadedOpenWikiRepo, loadRepository } from "@openwiki/repo";
import { collectIndexRecords } from "./indexer.ts";
import { stringValue } from "./ranking-signals.ts";
import type { SearchCorpus, SearchCorpusRecord } from "./types.ts";

export async function exportSearchCorpus(
  root: string,
  options: { visibility?: "public" | "internal" } = {},
): Promise<SearchCorpus> {
  const repo = await loadRepository(root);
  const visibility = options.visibility ?? "public";
  const sourceById = new Map(repo.sources.map((source) => [source.id, source]));
  const records = (await collectIndexRecords(repo))
    .filter((record) => recordAllowedInCorpus(record, visibility, sourceById))
    .filter((record) => visibility === "internal" || indexRecordPublicAllowed(repo, record, sourceById))
    .map((record) => corpusRecordFromIndex(record, visibility));
  return {
    generated_at: new Date().toISOString(),
    visibility,
    record_count: records.length,
    records,
  };
}

function indexRecordPublicAllowed(repo: LoadedOpenWikiRepo, record: IndexRecord, sourceById: Map<string, SourceRecord>): boolean {
  if (record.type === "page") {
    return publicPathAllowed(repo.policy, record.path);
  }
  if (record.type === "source" || record.type === "source_fragment") {
    return record.source_ids.every((sourceId) => {
      const source = sourceById.get(sourceId);
      return sourceExportable(source) && source !== undefined && publicPathAllowed(repo.policy, source.path);
    });
  }
  if (record.type === "claim") {
    const claim = repo.claims.find((candidate) => candidate.id === record.id);
    const page = claim === undefined ? undefined : repo.pages.find((candidate) => candidate.id === claim.page_id);
    return (
      claim !== undefined &&
      page !== undefined &&
      publicPathAllowed(repo.policy, page.path) &&
      claim.source_ids.every((sourceId) => {
        const source = sourceById.get(sourceId);
        return sourceExportable(source) && source !== undefined && publicPathAllowed(repo.policy, source.path);
      })
    );
  }
  if (record.type === "fact") {
    const fact = repo.facts.find((candidate) => candidate.id === record.id);
    if (fact === undefined || fact.status === "forgotten") {
      return false;
    }
    return (
      publicPathAllowed(repo.policy, fact.path) &&
      fact.page_ids.every((pageId) => {
        const page = repo.pages.find((candidate) => candidate.id === pageId);
        return page !== undefined && publicPathAllowed(repo.policy, page.path);
      }) &&
      fact.source_ids.every((sourceId) => {
        const source = sourceById.get(sourceId);
        return sourceExportable(source) && source !== undefined && publicPathAllowed(repo.policy, source.path);
      }) &&
      fact.claim_ids.every((claimId) => {
        const claim = repo.claims.find((candidate) => candidate.id === claimId);
        const page = claim === undefined ? undefined : repo.pages.find((candidate) => candidate.id === claim.page_id);
        return claim !== undefined && page !== undefined && publicPathAllowed(repo.policy, page.path);
      })
    );
  }
  if (record.type === "take") {
    const take = repo.takes.find((candidate) => candidate.id === record.id);
    if (take === undefined) {
      return false;
    }
    return (
      publicPathAllowed(repo.policy, take.path) &&
      take.page_ids.every((pageId) => {
        const page = repo.pages.find((candidate) => candidate.id === pageId);
        return page !== undefined && publicPathAllowed(repo.policy, page.path);
      }) &&
      take.source_ids.every((sourceId) => {
        const source = sourceById.get(sourceId);
        return sourceExportable(source) && source !== undefined && publicPathAllowed(repo.policy, source.path);
      }) &&
      take.claim_ids.every((claimId) => {
        const claim = repo.claims.find((candidate) => candidate.id === claimId);
        const page = claim === undefined ? undefined : repo.pages.find((candidate) => candidate.id === claim.page_id);
        return claim !== undefined && page !== undefined && publicPathAllowed(repo.policy, page.path);
      })
    );
  }
  if (record.type === "proposal") {
    const proposal = repo.proposals.find((candidate) => candidate.id === record.id);
    return proposal !== undefined && (proposal.target_path ? publicPathAllowed(repo.policy, proposal.target_path) : publicPathAllowed(repo.policy, proposal.path));
  }
  if (record.type === "comment") {
    const comment = repo.comments.find((candidate) => candidate.id === record.id);
    const proposal = comment === undefined ? undefined : repo.proposals.find((candidate) => candidate.id === comment.proposal_id);
    return proposal !== undefined && (proposal.target_path ? publicPathAllowed(repo.policy, proposal.target_path) : publicPathAllowed(repo.policy, proposal.path));
  }
  if (record.type === "decision") {
    const decision = repo.decisions.find((candidate) => candidate.id === record.id);
    const proposal = decision === undefined ? undefined : repo.proposals.find((candidate) => candidate.id === decision.proposal_id);
    return proposal !== undefined && (proposal.target_path ? publicPathAllowed(repo.policy, proposal.target_path) : publicPathAllowed(repo.policy, proposal.path));
  }
  if (record.type === "event") {
    const event = repo.events.find((candidate) => candidate.id === record.id);
    if (event?.record_id) {
      const related = repo.pages.find((page) => page.id === event.record_id) ?? repo.sources.find((source) => source.id === event.record_id);
      if (related) {
        return publicPathAllowed(repo.policy, related.path);
      }
      const proposal = repo.proposals.find((candidate) => candidate.id === event.record_id);
      if (proposal) {
        return proposal.target_path ? publicPathAllowed(repo.policy, proposal.target_path) : publicPathAllowed(repo.policy, proposal.path);
      }
    }
  }
  return splitIndexPathExpression(record.path).every((repoPath) => publicPathAllowed(repo.policy, repoPath));
}

function splitIndexPathExpression(pathExpression: string): string[] {
  return pathExpression
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.includes("://") && !entry.startsWith("/") && !entry.includes(".."));
}

function recordAllowedInCorpus(
  record: IndexRecord,
  visibility: "public" | "internal",
  sourceById: Map<string, SourceRecord>,
): boolean {
  if (visibility === "internal") {
    return true;
  }
  if (record.type !== "source" && record.type !== "source_fragment") {
    return true;
  }
  return record.source_ids.every((sourceId) => sourceExportable(sourceById.get(sourceId)));
}

function sourceExportable(source: SourceRecord | undefined): boolean {
  const sensitivity = stringValue(source?.trust?.sensitivity);
  return sensitivity !== "private" && sensitivity !== "restricted" && sensitivity !== "confidential";
}

function corpusRecordFromIndex(record: IndexRecord, visibility: "public" | "internal"): SearchCorpusRecord {
  const corpusRecord: SearchCorpusRecord = {
    id: record.id,
    type: record.type,
    title: record.title,
    summary: record.summary,
    uri: record.uri,
    path: record.path,
    topics: record.topics,
    source_ids: record.source_ids,
    status: record.status,
    updated_at: record.updated_at,
    search_text: corpusSearchText(record, visibility),
  };
  if (record.url) {
    corpusRecord.url = record.url;
  }
  return corpusRecord;
}

function corpusSearchText(record: IndexRecord, visibility: "public" | "internal"): string {
  const publicFields = [record.title, record.summary, record.path, record.topics.join(" "), record.source_ids.join(" ")];
  if (visibility === "public" && record.type === "event") {
    return boundedSearchText(publicFields);
  }
  return boundedSearchText([...publicFields, record.body]);
}

function boundedSearchText(values: string[]): string {
  return values
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20000);
}
