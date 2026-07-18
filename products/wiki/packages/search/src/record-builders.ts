import type { IndexRecord } from "./records.ts";
import { type ClaimRecord, type DecisionRecord, type EventRecord, type FactRecord, idToUri, type PageRecord, type ProposalCommentRecord, type ProposalRecord, type SourceRecord, type TakeRecord } from "@openwiki/core";
import { listRecentChanges, type RecentChangeEntry } from "@openwiki/git";
import { canReadRecordReference, type PolicyContext } from "@openwiki/policy";
import { type LoadedOpenWikiRepo, readSourceContent } from "@openwiki/repo";
import { chunkText, summaryFromText } from "./text.ts";

export function recordFromPage(page: PageRecord): IndexRecord {
  return {
    id: page.id,
    type: "page",
    title: page.title,
    summary: page.summary ?? "",
    uri: page.uri,
    path: page.path,
    body: page.body,
    topics: page.topics,
    source_ids: page.source_ids,
    status: page.status,
    updated_at: page.updated_at,
  };
}

export function recordFromSource(source: SourceRecord): IndexRecord {
  const record: IndexRecord = {
    id: source.id,
    type: "source",
    title: source.title,
    summary: source.url ?? source.source_type,
    uri: source.uri,
    path: source.path,
    body: [source.title, source.source_type, source.url ?? "", source.content_hash ?? ""].join(" "),
    topics: [],
    source_ids: [source.id],
    status: "active",
    updated_at: source.retrieved_at,
  };
  if (source.url) {
    record.url = source.url;
  }
  return record;
}

export async function recordsFromSourceFragments(root: string, sources: SourceRecord[]): Promise<IndexRecord[]> {
  const nested = await Promise.all(
    sources.map(async (source) => {
      const content = await readSourceContent(root, source.id, { maxBytes: 256 * 1024 });
      if (content.content === null) {
        return [];
      }
      return sourceFragmentsFromBody(source, content.content.body, content.content.path);
    }),
  );
  return nested.flat();
}

function sourceFragmentsFromBody(source: SourceRecord, body: string, contentPath: string): IndexRecord[] {
  const chunks = chunkText(body, 3200);
  return chunks.map((chunk, index) => {
    const fragmentIndex = String(index + 1).padStart(4, "0");
    const id = `fragment:${source.id}:${fragmentIndex}`;
    return {
      id,
      type: "source_fragment",
      title: `${source.title} Fragment ${index + 1}`,
      summary: summaryFromText(chunk),
      uri: idToUri(id),
      path: contentPath,
      body: chunk,
      topics: [],
      source_ids: [source.id],
      status: "active",
      updated_at: source.retrieved_at,
      ...(source.url === undefined ? {} : { url: source.url }),
    };
  });
}

export function recordFromClaim(claim: ClaimRecord, pages: PageRecord[], sources: SourceRecord[]): IndexRecord {
  const page = pages.find((candidate) => candidate.id === claim.page_id);
  const sourceTitles = sources
    .filter((source) => claim.source_ids.includes(source.id))
    .map((source) => source.title)
    .join(" ");
  return {
    id: claim.id,
    type: "claim",
    title: claim.text,
    summary: page?.title ?? claim.page_id,
    uri: claim.uri,
    path: "claims/claim-index.jsonl",
    body: [claim.text, page?.title ?? "", sourceTitles, claim.confidence, claim.risk].join(" "),
    topics: page?.topics ?? [],
    source_ids: claim.source_ids,
    status: claim.status,
    updated_at: claim.last_verified_at ?? page?.updated_at ?? "",
  };
}

export function recordFromFact(fact: FactRecord, pages: PageRecord[], sources: SourceRecord[], claims: ClaimRecord[]): IndexRecord {
  const pageTitles = pages
    .filter((page) => fact.page_ids.includes(page.id))
    .map((page) => page.title)
    .join(" ");
  const sourceTitles = sources
    .filter((source) => fact.source_ids.includes(source.id))
    .map((source) => source.title)
    .join(" ");
  const claimTexts = claims
    .filter((claim) => fact.claim_ids.includes(claim.id))
    .map((claim) => claim.text)
    .join(" ");
  return {
    id: fact.id,
    type: "fact",
    title: fact.text,
    summary: [fact.kind, fact.confidence, fact.status].join(" / "),
    uri: fact.uri,
    path: fact.path,
    body: [fact.text, fact.kind, pageTitles, sourceTitles, claimTexts, fact.subject_ids.join(" ")].join(" "),
    topics: uniqueTopics(fact.page_ids.flatMap((pageId) => pages.find((page) => page.id === pageId)?.topics ?? [])),
    source_ids: fact.source_ids,
    status: fact.status,
    updated_at: fact.updated_at,
  };
}

export function recordFromTake(take: TakeRecord, pages: PageRecord[], sources: SourceRecord[], claims: ClaimRecord[]): IndexRecord {
  const pageTitles = pages
    .filter((page) => take.page_ids.includes(page.id))
    .map((page) => page.title)
    .join(" ");
  const sourceTitles = sources
    .filter((source) => take.source_ids.includes(source.id))
    .map((source) => source.title)
    .join(" ");
  const claimTexts = claims
    .filter((claim) => take.claim_ids.includes(claim.id))
    .map((claim) => claim.text)
    .join(" ");
  return {
    id: take.id,
    type: "take",
    title: take.statement,
    summary: [
      `${Math.round(take.probability * 100)}%`,
      take.confidence,
      take.status,
      take.resolution ?? "",
    ].filter(Boolean).join(" / "),
    uri: take.uri,
    path: take.path,
    body: [take.statement, take.rationale, pageTitles, sourceTitles, claimTexts, take.resolution ?? "", String(take.score ?? "")].join(" "),
    topics: uniqueTopics(take.page_ids.flatMap((pageId) => pages.find((page) => page.id === pageId)?.topics ?? [])),
    source_ids: take.source_ids,
    status: take.status,
    updated_at: take.updated_at,
  };
}

export function recordFromProposal(proposal: ProposalRecord): IndexRecord {
  return {
    id: proposal.id,
    type: "proposal",
    title: proposal.title,
    summary: [proposal.status, proposal.rationale ?? ""].filter(Boolean).join(" "),
    uri: proposal.uri,
    path: proposal.path,
    body: [proposal.title, proposal.status, proposal.rationale ?? "", proposal.target_ids.join(" ")].join(" "),
    topics: [],
    source_ids: [],
    status: proposal.status,
    updated_at: proposal.created_at,
  };
}

function uniqueTopics(topics: string[]): string[] {
  return topics.filter((topic, index, values) => values.indexOf(topic) === index);
}

export function recordFromProposalComment(comment: ProposalCommentRecord): IndexRecord {
  return {
    id: comment.id,
    type: "comment",
    title: `Comment on ${comment.proposal_id}`,
    summary: comment.body,
    uri: comment.uri,
    path: comment.path,
    body: [comment.proposal_id, comment.actor_id, comment.body].join(" "),
    topics: [],
    source_ids: [],
    status: "active",
    updated_at: comment.created_at,
  };
}

export function recordFromDecision(decision: DecisionRecord): IndexRecord {
  return {
    id: decision.id,
    type: "decision",
    title: `${decision.decision}: ${decision.proposal_id}`,
    summary: decision.rationale,
    uri: decision.uri,
    path: decision.path,
    body: [decision.decision, decision.proposal_id, decision.rationale].join(" "),
    topics: [],
    source_ids: [],
    status: decision.decision,
    updated_at: decision.decided_at,
  };
}

export function recordFromEvent(event: EventRecord): IndexRecord {
  return {
    id: event.id,
    type: "event",
    title: [event.type, event.record_id].filter(Boolean).join(": "),
    summary: [event.operation, event.actor_id, event.record_type].filter(Boolean).join(" "),
    uri: event.uri,
    path: event.path,
    body: [
      event.type,
      event.operation ?? "",
      event.actor_id ?? "",
      event.record_id ?? "",
      event.record_type ?? "",
      event.workspace_id,
      event.data === undefined ? "" : JSON.stringify(event.data),
    ].join(" "),
    topics: [],
    source_ids: [],
    status: event.type,
    updated_at: event.occurred_at,
  };
}

export async function recordsFromRecentChanges(root: string): Promise<IndexRecord[]> {
  const recent = await listRecentChanges(root, 100);
  return recent.changes.map(recordFromRecentChange);
}

function recordFromRecentChange(change: RecentChangeEntry): IndexRecord {
  const id = `commit:${change.short_sha}`;
  const files = change.files.map((file) => `${file.status} ${file.path}`);
  return {
    id,
    type: "recent_change",
    title: change.subject,
    summary: `${change.short_sha} by ${change.author_name}`,
    uri: idToUri(id),
    path: change.files.map((file) => file.path).join(" "),
    body: [change.sha, change.short_sha, change.subject, change.author_name, change.author_email, ...files].join(" "),
    topics: [],
    source_ids: [],
    status: "committed",
    updated_at: change.date,
  };
}

export function indexRecordAllowedForPolicy(repo: LoadedOpenWikiRepo, record: IndexRecord, context: PolicyContext | undefined): boolean {
  if (context === undefined) {
    return true;
  }
  return canReadRecordReference(repo, context, {
    id: record.id,
    type: record.type,
    path: record.path,
    source_ids: record.source_ids,
  });
}
