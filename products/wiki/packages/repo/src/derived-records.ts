import { type ClaimRecord, type DecisionRecord, type EventRecord, type FactRecord, idToUri, type InboxItemRecord, type OpenWikiSectionVisibility, type PageRecord, type ProposalCommentRecord, type ProposalRecord, type RunRecord, openWikiDerivedEventSubjectView, openWikiDerivedRunSubjectView, openWikiProposalUpdatedAt, slugify, type SourceRecord, type TakeRecord, type TopicSummary } from "@openwiki/core";
import { pathVisibility } from "@openwiki/policy";
import { topicsForPage } from "./readers.ts";
import type { LoadedOpenWikiRepo } from "./types.ts";

// Canonical shape for a derived index/search record. Both the SQLite (`@openwiki/index-store`)
// and Postgres (`@openwiki/postgres-runtime`) store engines build records through the functions
// below, so this type and those builders live here, in the shared lower layer, to keep the two
// engines from drifting apart.
export interface DerivedRecord {
  workspace_id: string;
  record_id: string;
  record_type: string;
  uri: string;
  title: string;
  summary: string;
  path: string;
  status: string;
  sensitivity: OpenWikiSectionVisibility;
  created_at: string;
  updated_at: string;
  json: Record<string, unknown>;
  search_text: string;
  topics: string[];
  source_ids: string[];
}

export interface SearchDocument {
  workspace_id: string;
  record_id: string;
  record_type: string;
  path: string;
  search_text: string;
  topics: string[];
  source_ids: string[];
}

export function proposalUpdatedAt(proposal: ProposalRecord): string {
  return openWikiProposalUpdatedAt(proposal);
}

export function collectDerivedRecords(repo: LoadedOpenWikiRepo, topics: TopicSummary[]): DerivedRecord[] {
  return [
    workspaceRecord(repo),
    policyRecord(repo, "sections", repo.policy.sections),
    policyRecord(repo, "grants", repo.policy.grants),
    policyRecord(repo, "approval-rules", repo.policy.approval_rules),
    ...repo.policy.sections.map((section) => recordFromSection(repo, section)),
    ...topics.map((topic) => recordFromTopic(repo, topic)),
    ...repo.pages.map((page) => recordFromPage(repo, page)),
    ...repo.sources.map((source) => recordFromSource(repo, source)),
    ...repo.claims.map((claim) => recordFromClaim(repo, claim)),
    ...repo.facts.map((fact) => recordFromFact(repo, fact)),
    ...repo.takes.map((take) => recordFromTake(repo, take)),
    ...repo.inbox.map((item) => recordFromInboxItem(repo, item)),
    ...repo.proposals.map((proposal) => recordFromProposal(repo, proposal)),
    ...repo.comments.map((comment) => recordFromComment(repo, comment)),
    ...repo.decisions.map((decision) => recordFromDecision(repo, decision)),
    ...repo.events.map((event) => recordFromEvent(repo, event)),
    ...repo.runs.map((run) => recordFromRun(repo, run)),
  ].sort((left, right) => left.record_type.localeCompare(right.record_type) || left.record_id.localeCompare(right.record_id));
}

export function workspaceRecord(repo: LoadedOpenWikiRepo): DerivedRecord {
  return baseRecord(repo, {
    record_id: repo.config.workspace_id,
    record_type: "workspace",
    uri: idToUri(repo.config.workspace_id),
    title: repo.config.title,
    summary: repo.config.repo_format,
    path: "openwiki.json",
    status: "active",
    created_at: repo.config.created_at,
    updated_at: repo.config.created_at,
    json: repo.config as unknown as Record<string, unknown>,
    search_text: [repo.config.title, repo.config.workspace_id, repo.config.repo_format].join(" "),
    topics: [],
    source_ids: [],
  });
}

export function policyRecord(repo: LoadedOpenWikiRepo, name: "sections" | "grants" | "approval-rules", body: unknown): DerivedRecord {
  const id = `policy:${name}`;
  return baseRecord(repo, {
    record_id: id,
    record_type: "policy",
    uri: idToUri(id),
    title: `Policy ${name}`,
    summary: "Git-backed OpenWiki policy file",
    path: `policy/${name}.json`,
    status: "active",
    created_at: repo.config.created_at,
    updated_at: repo.config.created_at,
    json: { id, type: "policy", body } as Record<string, unknown>,
    search_text: [id, name, JSON.stringify(body)].join(" "),
    topics: [],
    source_ids: [],
  });
}

export function recordFromSection(repo: LoadedOpenWikiRepo, section: LoadedOpenWikiRepo["policy"]["sections"][number]): DerivedRecord {
  const visibility = section.visibility ?? "public";
  return baseRecord(repo, {
    record_id: section.id,
    record_type: "section",
    uri: idToUri(section.id),
    title: section.title,
    summary: section.description ?? visibility,
    path: "policy/sections.json",
    status: visibility,
    sensitivity: visibility,
    created_at: repo.config.created_at,
    updated_at: repo.config.created_at,
    json: section as unknown as Record<string, unknown>,
    search_text: [section.id, section.title, section.description ?? "", section.paths.join(" ")].join(" "),
    topics: [],
    source_ids: [],
  });
}

export function recordFromTopic(repo: LoadedOpenWikiRepo, topic: TopicSummary): DerivedRecord {
  const id = `topic:${slugify(topic.topic)}`;
  return baseRecord(repo, {
    record_id: id,
    record_type: "topic",
    uri: idToUri(id),
    title: topic.topic,
    summary: `${topic.page_count} pages, ${topic.claim_count} claims, ${topic.source_count} sources`,
    path: "derived/topics.json",
    status: "active",
    created_at: repo.config.created_at,
    updated_at: topic.updated_at || repo.config.created_at,
    json: { id, type: "topic", ...topic },
    search_text: [topic.topic, topic.page_ids.join(" "), topic.source_ids.join(" ")].join(" "),
    topics: [topic.topic],
    source_ids: topic.source_ids,
  });
}

export function recordFromPage(repo: LoadedOpenWikiRepo, page: PageRecord): DerivedRecord {
  return baseRecord(repo, {
    record_id: page.id,
    record_type: "page",
    uri: page.uri,
    title: page.title,
    summary: page.summary ?? "",
    path: page.path,
    status: page.status,
    created_at: page.created_at,
    updated_at: page.updated_at,
    json: page as unknown as Record<string, unknown>,
    search_text: [page.title, page.summary ?? "", page.body, page.topics.join(" ")].join(" "),
    topics: page.topics,
    source_ids: page.source_ids,
  });
}

export function recordFromSource(repo: LoadedOpenWikiRepo, source: SourceRecord): DerivedRecord {
  return baseRecord(repo, {
    record_id: source.id,
    record_type: "source",
    uri: source.uri,
    title: source.title,
    summary: source.url ?? source.source_type,
    path: source.path,
    status: "active",
    created_at: source.retrieved_at,
    updated_at: source.retrieved_at,
    json: source as unknown as Record<string, unknown>,
    search_text: [source.title, source.source_type, source.url ?? "", source.content_hash ?? ""].join(" "),
    topics: [],
    source_ids: [source.id],
  });
}

export function recordFromClaim(repo: LoadedOpenWikiRepo, claim: ClaimRecord): DerivedRecord {
  return baseRecord(repo, {
    record_id: claim.id,
    record_type: "claim",
    uri: claim.uri,
    title: claim.text,
    summary: claim.page_id,
    path: "claims/claim-index.jsonl",
    status: claim.status,
    created_at: claim.last_verified_at ?? repo.config.created_at,
    updated_at: claim.last_verified_at ?? repo.config.created_at,
    json: claim as unknown as Record<string, unknown>,
    search_text: [claim.text, claim.page_id, claim.confidence, claim.risk, claim.source_ids.join(" ")].join(" "),
    topics: topicsForPage(repo, claim.page_id),
    source_ids: claim.source_ids,
  });
}

export function recordFromFact(repo: LoadedOpenWikiRepo, fact: FactRecord): DerivedRecord {
  return baseRecord(repo, {
    record_id: fact.id,
    record_type: "fact",
    uri: fact.uri,
    title: fact.text,
    summary: [fact.kind, fact.confidence, fact.status].join(" / "),
    path: fact.path,
    status: fact.status,
    sensitivity: fact.sensitivity,
    created_at: fact.created_at,
    updated_at: fact.updated_at,
    json: fact as unknown as Record<string, unknown>,
    search_text: [
      fact.text,
      fact.kind,
      fact.confidence,
      fact.status,
      fact.subject_ids.join(" "),
      fact.page_ids.join(" "),
      fact.source_ids.join(" "),
      fact.claim_ids.join(" "),
    ].join(" "),
    topics: uniqueTopics(fact.page_ids.flatMap((pageId) => topicsForPage(repo, pageId))),
    source_ids: fact.source_ids,
  });
}

export function recordFromTake(repo: LoadedOpenWikiRepo, take: TakeRecord): DerivedRecord {
  return baseRecord(repo, {
    record_id: take.id,
    record_type: "take",
    uri: take.uri,
    title: take.statement,
    summary: [
      `${Math.round(take.probability * 100)}%`,
      take.confidence,
      take.status,
      take.resolution ?? "",
    ].filter(Boolean).join(" / "),
    path: take.path,
    status: take.status,
    created_at: take.created_at,
    updated_at: take.updated_at,
    json: take as unknown as Record<string, unknown>,
    search_text: [
      take.statement,
      take.rationale,
      String(take.probability),
      take.confidence,
      take.status,
      take.resolution ?? "",
      take.page_ids.join(" "),
      take.source_ids.join(" "),
      take.claim_ids.join(" "),
    ].join(" "),
    topics: uniqueTopics(take.page_ids.flatMap((pageId) => topicsForPage(repo, pageId))),
    source_ids: take.source_ids,
  });
}

function recordFromInboxItem(repo: LoadedOpenWikiRepo, item: InboxItemRecord): DerivedRecord {
  return baseRecord(repo, {
    record_id: item.id,
    record_type: "inbox",
    uri: item.uri,
    title: item.title,
    summary: [item.inbox_kind, item.provider, item.status].join(" / "),
    path: item.target_path ?? item.payload?.path ?? item.path,
    status: item.status,
    sensitivity: item.sensitivity ?? "private",
    created_at: item.received_at,
    updated_at: item.updated_at,
    json: item as unknown as Record<string, unknown>,
    search_text: [item.title, item.inbox_kind, item.provider, item.external_id ?? "", JSON.stringify(item.metadata ?? {})].join(" "),
    topics: [],
    source_ids: item.source_ids ?? [],
  });
}

function uniqueTopics(topics: string[]): string[] {
  return topics.filter((topic, index, values) => values.indexOf(topic) === index);
}

export function recordFromProposal(repo: LoadedOpenWikiRepo, proposal: ProposalRecord): DerivedRecord {
  return baseRecord(repo, {
    record_id: proposal.id,
    record_type: "proposal",
    uri: proposal.uri,
    title: proposal.title,
    summary: proposal.rationale ?? proposal.status,
    path: proposal.path,
    status: proposal.status,
    created_at: proposal.created_at,
    updated_at: proposalUpdatedAt(proposal),
    json: proposal as unknown as Record<string, unknown>,
    search_text: [proposal.title, proposal.status, proposal.actor_id, proposal.rationale ?? "", proposal.target_ids.join(" ")].join(" "),
    topics: [],
    source_ids: [],
  });
}

export function recordFromComment(repo: LoadedOpenWikiRepo, comment: ProposalCommentRecord): DerivedRecord {
  return baseRecord(repo, {
    record_id: comment.id,
    record_type: "comment",
    uri: comment.uri,
    title: `Comment on ${comment.proposal_id}`,
    summary: comment.body,
    path: comment.path,
    status: "active",
    created_at: comment.created_at,
    updated_at: comment.created_at,
    json: comment as unknown as Record<string, unknown>,
    search_text: [comment.proposal_id, comment.actor_id, comment.body].join(" "),
    topics: [],
    source_ids: [],
  });
}

export function recordFromDecision(repo: LoadedOpenWikiRepo, decision: DecisionRecord): DerivedRecord {
  return baseRecord(repo, {
    record_id: decision.id,
    record_type: "decision",
    uri: decision.uri,
    title: `${decision.decision}: ${decision.proposal_id}`,
    summary: decision.rationale,
    path: decision.path,
    status: decision.decision,
    created_at: decision.decided_at,
    updated_at: decision.decided_at,
    json: decision as unknown as Record<string, unknown>,
    search_text: [decision.decision, decision.proposal_id, decision.actor_id, decision.rationale].join(" "),
    topics: [],
    source_ids: [],
  });
}

export function recordFromEvent(repo: LoadedOpenWikiRepo, event: EventRecord): DerivedRecord {
  const view = openWikiDerivedEventSubjectView(event);
  const indexableEvent = view.record;
  return baseRecord(repo, {
    record_id: indexableEvent.id,
    record_type: "event",
    uri: indexableEvent.uri,
    title: [indexableEvent.type, indexableEvent.record_id].filter(Boolean).join(": "),
    summary: [indexableEvent.operation, indexableEvent.actor_id, indexableEvent.record_type].filter(Boolean).join(" "),
    path: indexableEvent.path,
    status: indexableEvent.type,
    sensitivity: indexableEvent.sensitivity ?? pathVisibility(repo.policy, indexableEvent.path),
    created_at: indexableEvent.occurred_at,
    updated_at: indexableEvent.occurred_at,
    json: indexableEvent as unknown as Record<string, unknown>,
    search_text: view.searchText,
    topics: [],
    source_ids: [],
  });
}

export function recordFromRun(repo: LoadedOpenWikiRepo, run: RunRecord): DerivedRecord {
  const view = openWikiDerivedRunSubjectView(run);
  const indexableRun = view.record;
  return baseRecord(repo, {
    record_id: indexableRun.id,
    record_type: "run",
    uri: indexableRun.uri,
    title: `${indexableRun.run_type}: ${indexableRun.status}`,
    summary: indexableRun.error ?? indexableRun.actor_id,
    path: indexableRun.path,
    status: indexableRun.status,
    sensitivity: indexableRun.sensitivity ?? pathVisibility(repo.policy, indexableRun.path),
    created_at: indexableRun.created_at,
    updated_at: indexableRun.completed_at ?? indexableRun.started_at ?? indexableRun.created_at,
    json: indexableRun as unknown as Record<string, unknown>,
    search_text: view.searchText,
    topics: [],
    source_ids: [],
  });
}

export function baseRecord(
  repo: LoadedOpenWikiRepo,
  input: Omit<DerivedRecord, "workspace_id" | "sensitivity"> & { sensitivity?: OpenWikiSectionVisibility },
): DerivedRecord {
  return {
    workspace_id: repo.config.workspace_id,
    sensitivity: input.sensitivity ?? pathVisibility(repo.policy, input.path),
    ...input,
  };
}

export function searchDocumentFromRecord(record: DerivedRecord): SearchDocument {
  return {
    workspace_id: record.workspace_id,
    record_id: record.record_id,
    record_type: record.record_type,
    path: record.path,
    search_text: record.search_text,
    topics: record.topics,
    source_ids: record.source_ids,
  };
}
