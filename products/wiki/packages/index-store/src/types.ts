import type { OpenWikiSectionVisibility, ProposalRecord, ProposalStatus } from "@openwiki/core";

export const INDEX_STORE_SCHEMA_VERSION = "0.1.1";

export const LOCAL_ORGANIZATION_ID = "organization:local";

export const LOCAL_TENANT_ID = "tenant:local";

export type IndexStoreCountTable = "records" | "edges" | "search_documents" | "effective_permissions";

export interface IndexStoreOptions {
  dbPath?: string;
}

export interface IndexStoreRebuildResult {
  root: string;
  dbPath: string;
  schemaVersion: string;
  sourceCommit: string;
  contentHash: string;
  recordCount: number;
  edgeCount: number;
  searchDocumentCount: number;
  effectivePermissionCount: number;
}

export interface IndexStoreSummary {
  root: string;
  dbPath: string;
  schemaVersion?: string;
  workspaceId?: string;
  sourceCommit?: string;
  contentHash?: string;
  generatedAt?: string;
  recordCount: number;
  edgeCount: number;
  searchDocumentCount: number;
  effectivePermissionCount: number;
}

export interface IndexStoreIntegrityResult extends IndexStoreSummary {
  ok: boolean;
  currentCommit: string;
  currentContentHash?: string;
  issues: string[];
}

export interface DerivedRecordRow {
  workspace_id: string;
  record_id: string;
  record_type: string;
  record_group: string;
  uri: string;
  title: string;
  summary: string;
  path: string;
  status: string;
  sensitivity?: OpenWikiSectionVisibility;
  created_at: string;
  updated_at: string;
  source_commit: string;
  json: Record<string, unknown>;
}

export interface IndexStoreRecordListOptions {
  type?: string;
  group?: string;
  prefix?: string;
  groupBy?: "group" | "page_type";
  limit?: number;
  offset?: number;
  visibility?: "all" | "public";
}

export interface IndexStoreRecordListItem {
  id: string;
  type: string;
  group: string;
  title: string;
  path?: string;
  summary?: string;
  status?: string;
  updated_at?: string;
}

export interface IndexStoreRecordGroupSummary {
  id: string;
  label: string;
  type: string;
  count: number;
}

export interface IndexStoreRecordList {
  source: "index-store";
  records: IndexStoreRecordListItem[];
  count: number;
  total: number;
  groups?: IndexStoreRecordGroupSummary[];
  next_cursor?: string;
}

export interface IndexStoreRecordRead {
  source: "index-store";
  record: DerivedRecordRow;
}

export interface DerivedEdgeRow {
  workspace_id: string;
  edge_id: string;
  from_id: string;
  to_id: string;
  edge_type: string;
  path?: string;
  anchor?: string;
  weight: number;
  source_commit: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface IndexStoreWorkspaceIndex {
  source: "index-store";
  workspace: Record<string, unknown>;
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

export interface IndexStoreProposalListOptions {
  statuses?: ProposalStatus[];
  actorId?: string;
  targetId?: string;
  targetPath?: string;
  sectionId?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  limit?: number;
}

export interface IndexStoreProposalList {
  source: "index-store";
  proposals: ProposalRecord[];
  total: number;
}

export interface GitCommitInfo {
  sha: string;
  parent_sha: string;
  author: string;
  authored_at: string;
  committer: string;
  committed_at: string;
  subject: string;
}

// Canonical record/search-document shapes are defined once in @openwiki/repo so the SQLite and
// Postgres store engines cannot drift apart. Re-exported here for existing local importers.
export type { DerivedRecord, SearchDocument } from "@openwiki/repo";
