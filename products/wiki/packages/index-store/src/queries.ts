import { indexStoreRecordFromJson, indexStoreWorkspaceConfigFromJson } from "./records.ts";
import { boundedOpenWikiListLimit, idToUri, type OpenWikiDerivedRecordType, openWikiProposalSectionIds, openWikiProposalTargetsPath, openWikiProposalTargetPaths, openWikiProposalUpdatedAt, type OpenWikiWorkspaceRegistry, type ProposalRecord } from "@openwiki/core";
import { listGraphEdges, listTopics, loadRepository } from "@openwiki/repo";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectDerivedRecords, derivedContentHash } from "./derived-records.ts";
import { currentDerivedContentHash, exists, gitCommitInfo, gitWorktreeClean } from "./git.ts";
import { defaultIndexStorePath } from "./paths.ts";
import { rowFromDerivedEdge, rowFromDerivedRecord, stringField } from "./rows.ts";
import { INDEX_STORE_SCHEMA_VERSION, LOCAL_ORGANIZATION_ID, LOCAL_TENANT_ID, type DerivedEdgeRow, type DerivedRecordRow, type IndexStoreCountTable, type IndexStoreIntegrityResult, type IndexStoreOptions, type IndexStoreProposalList, type IndexStoreProposalListOptions, type IndexStoreRecordGroupSummary, type IndexStoreRecordList, type IndexStoreRecordListItem, type IndexStoreRecordListOptions, type IndexStoreRecordRead, type IndexStoreSummary, type IndexStoreWorkspaceIndex } from "./types.ts";

export async function readIndexStoreSummary(root: string, options: IndexStoreOptions = {}): Promise<IndexStoreSummary> {
  const resolvedRoot = path.resolve(root);
  const dbPath = options.dbPath ?? defaultIndexStorePath(resolvedRoot);
  const db = new DatabaseSync(dbPath);
  try {
    const metadata = readMetadata(db);
    const schemaVersion = metadata.get("schema_version");
    const workspaceId = metadata.get("workspace_id");
    const sourceCommit = metadata.get("source_commit");
    const contentHash = metadata.get("content_hash");
    const generatedAt = metadata.get("generated_at");
    return {
      root: resolvedRoot,
      dbPath,
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(sourceCommit === undefined ? {} : { sourceCommit }),
      ...(contentHash === undefined ? {} : { contentHash }),
      ...(generatedAt === undefined ? {} : { generatedAt }),
      recordCount: countRows(db, "records"),
      edgeCount: countRows(db, "edges"),
      searchDocumentCount: countRows(db, "search_documents"),
      effectivePermissionCount: countRows(db, "effective_permissions"),
    };
  } finally {
    db.close();
  }
}

export async function checkIndexStoreIntegrity(root: string, options: IndexStoreOptions = {}): Promise<IndexStoreIntegrityResult> {
  const resolvedRoot = path.resolve(root);
  const dbPath = options.dbPath ?? defaultIndexStorePath(resolvedRoot);
  if (!(await exists(dbPath))) {
    return {
      root: resolvedRoot,
      dbPath,
      currentCommit: (await gitCommitInfo(resolvedRoot))?.sha ?? "uncommitted",
      ok: false,
      issues: ["index store does not exist; run openwiki db rebuild"],
      recordCount: 0,
      edgeCount: 0,
      searchDocumentCount: 0,
      effectivePermissionCount: 0,
    };
  }

  const [summary, repo, graph, topics, commitInfo] = await Promise.all([
    readIndexStoreSummary(resolvedRoot, { dbPath }),
    loadRepository(resolvedRoot),
    listGraphEdges(resolvedRoot),
    listTopics(resolvedRoot),
    gitCommitInfo(resolvedRoot),
  ]);
  const currentCommit = commitInfo?.sha ?? "uncommitted";
  const records = collectDerivedRecords(repo, topics.topics);
  const currentContentHash = derivedContentHash(repo, records, graph.edges);
  const issues: string[] = [];

  if (summary.schemaVersion !== INDEX_STORE_SCHEMA_VERSION) {
    issues.push(`schema version mismatch: indexed=${summary.schemaVersion ?? "missing"} expected=${INDEX_STORE_SCHEMA_VERSION}`);
  }
  if (summary.workspaceId !== repo.config.workspace_id) {
    issues.push(`workspace mismatch: indexed=${summary.workspaceId ?? "missing"} current=${repo.config.workspace_id}`);
  }
  if (summary.sourceCommit !== currentCommit) {
    issues.push(`source commit mismatch: indexed=${summary.sourceCommit ?? "missing"} current=${currentCommit}`);
  }
  if (summary.contentHash !== currentContentHash) {
    issues.push("content hash mismatch: Git workspace content has changed since the index-store rebuild");
  }
  if (summary.recordCount !== records.length) {
    issues.push(`record count mismatch: indexed=${summary.recordCount} current=${records.length}`);
  }
  if (summary.edgeCount !== graph.edges.length) {
    issues.push(`edge count mismatch: indexed=${summary.edgeCount} current=${graph.edges.length}`);
  }
  if (summary.searchDocumentCount !== records.length) {
    issues.push(`search document count mismatch: indexed=${summary.searchDocumentCount} current=${records.length}`);
  }

  return {
    ...summary,
    currentCommit,
    currentContentHash,
    ok: issues.length === 0,
    issues,
  };
}

export async function listIndexStoreRecords(
  root: string,
  options: IndexStoreOptions & { type?: string; limit?: number } = {},
): Promise<{ records: DerivedRecordRow[]; total: number }> {
  const db = new DatabaseSync(options.dbPath ?? defaultIndexStorePath(root));
  try {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const rows = options.type
      ? db
          .prepare("SELECT * FROM records WHERE record_type = ? ORDER BY record_type, title, record_id LIMIT ?")
          .all(options.type, limit)
      : db.prepare("SELECT * FROM records ORDER BY record_type, title, record_id LIMIT ?").all(limit);
    return {
      records: rows.map(rowFromDerivedRecord),
      total: countRows(db, "records"),
    };
  } finally {
    db.close();
  }
}

export async function listCurrentIndexStoreRecords(
  root: string,
  options: IndexStoreRecordListOptions = {},
): Promise<IndexStoreRecordList | undefined> {
  const db = await openCurrentIndexStore(root);
  if (!db) {
    return undefined;
  }
  try {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const { where, params } = recordListWhere(options);
    const rows = db
      .prepare(`
        SELECT record_id, record_type, record_group, title, summary, path, status, updated_at
        FROM records
        ${where}
        ORDER BY record_type, title, record_id
        LIMIT ? OFFSET ?
      `)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM records ${where}`).get(...params) as { count: number | bigint };
    const groups = options.groupBy === "group" || options.groupBy === "page_type"
      ? recordGroupsFromIndexStore(db, where, params)
      : undefined;
    const records = rows.map(recordListItemFromRow);
    const total = Number(totalRow.count);
    return {
      source: "index-store",
      records,
      count: records.length,
      total,
      ...(groups === undefined ? {} : { groups }),
      ...(total > offset + records.length ? { next_cursor: `offset:${offset + records.length}` } : {}),
    };
  } finally {
    db.close();
  }
}

export async function readCurrentIndexStoreRecord(
  root: string,
  id: string,
  options: { visibility?: "all" | "public" } = {},
): Promise<IndexStoreRecordRead | undefined> {
  const db = await openCurrentIndexStore(root);
  if (!db) {
    return undefined;
  }
  try {
    const visibilityClause = options.visibility === "public" ? "AND (sensitivity IS NULL OR sensitivity = 'public')" : "";
    const row = db
      .prepare(`SELECT * FROM records WHERE record_id = ? ${visibilityClause} LIMIT 1`)
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : { source: "index-store", record: rowFromDerivedRecord(row) };
  } finally {
    db.close();
  }
}

export async function listIndexStoreEdges(
  root: string,
  options: IndexStoreOptions & { type?: string; limit?: number } = {},
): Promise<{ edges: DerivedEdgeRow[]; total: number }> {
  const db = new DatabaseSync(options.dbPath ?? defaultIndexStorePath(root));
  try {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const rows = options.type
      ? db.prepare("SELECT * FROM edges WHERE edge_type = ? ORDER BY edge_type, from_id, to_id LIMIT ?").all(options.type, limit)
      : db.prepare("SELECT * FROM edges ORDER BY edge_type, from_id, to_id LIMIT ?").all(limit);
    return {
      edges: rows.map(rowFromDerivedEdge),
      total: countRows(db, "edges"),
    };
  } finally {
    db.close();
  }
}

export async function readCurrentIndexStoreWorkspaceIndex(root: string): Promise<IndexStoreWorkspaceIndex | undefined> {
  const db = await openCurrentIndexStore(root);
  if (!db) {
    return undefined;
  }
  try {
    const workspace = db.prepare("SELECT json FROM workspaces LIMIT 1").get() as { json: string } | undefined;
    if (!workspace) {
      return undefined;
    }
    return {
      source: "index-store",
      workspace: indexStoreWorkspaceConfigFromJson(workspace.json),
      counts: {
        pages: recordTypeCount(db, "page"),
        sources: recordTypeCount(db, "source"),
        claims: recordTypeCount(db, "claim"),
        facts: recordTypeCount(db, "fact"),
        takes: recordTypeCount(db, "take"),
        proposals: recordTypeCount(db, "proposal"),
        comments: recordTypeCount(db, "comment"),
        decisions: recordTypeCount(db, "decision"),
        events: recordTypeCount(db, "event"),
        runs: recordTypeCount(db, "run"),
      },
    };
  } finally {
    db.close();
  }
}

export async function readCurrentIndexStoreWorkspaceRegistry(root: string): Promise<OpenWikiWorkspaceRegistry | undefined> {
  const db = await openCurrentIndexStore(root);
  if (!db) {
    return undefined;
  }
  try {
    const organizations = db.prepare("SELECT * FROM organizations ORDER BY organization_id").all() as Array<Record<string, unknown>>;
    const tenants = db.prepare("SELECT * FROM tenants ORDER BY tenant_id").all() as Array<Record<string, unknown>>;
    const workspaces = db.prepare("SELECT * FROM workspaces ORDER BY workspace_id").all() as Array<Record<string, unknown>>;
    const repos = db.prepare("SELECT * FROM workspace_repos ORDER BY workspace_id, repo_id").all() as Array<Record<string, unknown>>;
    if (workspaces.length === 0) {
      return undefined;
    }
    return {
      source: "index-store",
      organizations: organizations.map((row) => {
        const id = stringField(row, "organization_id") ?? LOCAL_ORGANIZATION_ID;
        return {
          id,
          uri: idToUri(id),
          type: "organization",
          title: stringField(row, "title") ?? "Untitled Organization",
          created_at: stringField(row, "created_at") ?? "",
        };
      }),
      tenants: tenants.map((row) => {
        const id = stringField(row, "tenant_id") ?? LOCAL_TENANT_ID;
        return {
          id,
          uri: idToUri(id),
          type: "tenant",
          organization_id: stringField(row, "organization_id") ?? LOCAL_ORGANIZATION_ID,
          title: stringField(row, "title") ?? "Untitled Tenant",
          created_at: stringField(row, "created_at") ?? "",
        };
      }),
      workspaces: workspaces.map((row) => {
        const config = indexStoreWorkspaceConfigFromJson(stringField(row, "json"));
        const id = stringField(row, "workspace_id") ?? config.workspace_id;
        const sourceCommit = stringField(row, "source_commit");
        return {
          id,
          uri: idToUri(id),
          type: "workspace",
          tenant_id: stringField(row, "tenant_id") ?? LOCAL_TENANT_ID,
          title: stringField(row, "title") ?? config.title,
          repo_format: config.repo_format,
          protocol_version: config.protocol_version,
          created_at: stringField(row, "created_at") ?? config.created_at,
          ...(sourceCommit === undefined ? {} : { source_commit: sourceCommit }),
          config,
        };
      }),
      repos: repos.map((row, index) => {
        const id = `workspace_repo:${index + 1}`;
        const remote = stringField(row, "remote");
        const branch = stringField(row, "branch");
        const remoteUrl = stringField(row, "remote_url");
        const credentialRef = stringField(row, "credential_ref");
        const sourceCommit = stringField(row, "source_commit");
        return {
          id,
          uri: idToUri(id),
          type: "workspace_repo",
          workspace_id: stringField(row, "workspace_id") ?? "",
          repo_id: stringField(row, "repo_id") ?? "repo:default",
          root_path: stringField(row, "root_path") ?? "",
          ...(remote === undefined ? {} : { remote }),
          ...(branch === undefined ? {} : { branch }),
          ...(remoteUrl === undefined ? {} : { remote_url: remoteUrl }),
          ...(credentialRef === undefined ? {} : { credential_ref: credentialRef }),
          ...(sourceCommit === undefined ? {} : { source_commit: sourceCommit }),
        };
      }),
    };
  } finally {
    db.close();
  }
}

export async function listCurrentIndexStoreProposals(
  root: string,
  options: IndexStoreProposalListOptions = {},
): Promise<IndexStoreProposalList | undefined> {
  const db = await openCurrentIndexStore(root);
  if (!db) {
    return undefined;
  }
  try {
    const rows = db.prepare("SELECT * FROM proposals ORDER BY updated_at DESC, proposal_id DESC").all() as Array<Record<string, unknown>>;
    const sections = readIndexStoreSections(db);
    const proposals = rows
      .map(proposalFromIndexStoreRow)
      .filter((proposal) => options.statuses === undefined || options.statuses.includes(proposal.status))
      .filter((proposal) => options.actorId === undefined || proposal.actor_id === options.actorId)
      .filter((proposal) => options.targetId === undefined || proposal.target_ids.includes(options.targetId))
      .filter((proposal) => options.targetPath === undefined || openWikiProposalTargetsPath(proposal, options.targetPath))
      .filter((proposal) => options.sectionId === undefined || openWikiProposalSectionIds(proposal, sections).includes(options.sectionId))
      .filter((proposal) => options.updatedAfter === undefined || openWikiProposalUpdatedAt(proposal) >= options.updatedAfter)
      .filter((proposal) => options.updatedBefore === undefined || openWikiProposalUpdatedAt(proposal) <= options.updatedBefore);
    const limit = boundedOpenWikiListLimit(options.limit, proposals.length, 1000);
    return { source: "index-store", proposals: proposals.slice(0, limit), total: proposals.length };
  } finally {
    db.close();
  }
}

export async function openCurrentIndexStore(root: string): Promise<DatabaseSync | undefined> {
  const resolvedRoot = path.resolve(root);
  const dbPath = defaultIndexStorePath(resolvedRoot);
  if (!(await exists(dbPath))) {
    return undefined;
  }
  const db = new DatabaseSync(dbPath);
  try {
    const metadata = readMetadata(db);
    if (metadata.get("schema_version") !== INDEX_STORE_SCHEMA_VERSION) {
      db.close();
      return undefined;
    }
    const currentCommit = (await gitCommitInfo(resolvedRoot))?.sha ?? "uncommitted";
    if (metadata.get("source_commit") !== currentCommit) {
      db.close();
      return undefined;
    }
    if (currentCommit === "uncommitted" && process.env.OPENWIKI_INDEX_STORE_ALLOW_UNCOMMITTED !== "1") {
      db.close();
      return undefined;
    }
    if (currentCommit !== "uncommitted" && !(await gitWorktreeClean(resolvedRoot))) {
      const contentHash = metadata.get("content_hash");
      if (contentHash === undefined || contentHash !== await currentDerivedContentHash(resolvedRoot)) {
        db.close();
        return undefined;
      }
    }
    return db;
  } catch {
    db.close();
    return undefined;
  }
}

export function recordTypeCount(db: DatabaseSync, type: string): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM records WHERE record_type = ?").get(type) as { count: number | bigint };
  return Number(row.count);
}

function recordListWhere(options: IndexStoreRecordListOptions): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (options.visibility === "public") {
    clauses.push("(sensitivity IS NULL OR sensitivity = 'public')");
  }
  if (options.type) {
    clauses.push("record_type = ?");
    params.push(options.type);
  }
  if (options.group) {
    clauses.push("record_group = ?");
    params.push(options.group);
  }
  const prefix = options.prefix?.trim().toLowerCase();
  if (prefix) {
    clauses.push("(lower(record_id) LIKE ? OR lower(title) LIKE ? OR lower(path) LIKE ?)");
    const like = `%${prefix}%`;
    params.push(like, like, like);
  }
  return {
    where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

function recordGroupsFromIndexStore(
  db: DatabaseSync,
  where: string,
  params: string[],
): IndexStoreRecordGroupSummary[] {
  const rows = db
    .prepare(`
      SELECT record_group, MIN(record_type) AS record_type, COUNT(*) AS count
      FROM records
      ${where}
      GROUP BY record_group
      ORDER BY record_group
    `)
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const id = stringField(row, "record_group") ?? "record";
    return {
      id,
      label: recordGroupLabel(id),
      type: stringField(row, "record_type") ?? "record",
      count: Number(row.count ?? 0),
    };
  });
}

function recordListItemFromRow(row: Record<string, unknown>): IndexStoreRecordListItem {
  const pathValue = stringField(row, "path");
  const summary = stringField(row, "summary");
  const status = stringField(row, "status");
  const updatedAt = stringField(row, "updated_at");
  return {
    id: stringField(row, "record_id") ?? "",
    type: stringField(row, "record_type") ?? "record",
    group: stringField(row, "record_group") ?? "record",
    title: stringField(row, "title") ?? stringField(row, "record_id") ?? "Untitled",
    ...(pathValue === undefined ? {} : { path: pathValue }),
    ...(summary === undefined ? {} : { summary }),
    ...(status === undefined ? {} : { status }),
    ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
  };
}

function recordGroupLabel(value: string): string {
  return value
    .split(/[_:\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Record";
}

export function recordsFromIndexStore<T>(db: DatabaseSync, type: OpenWikiDerivedRecordType): T[] {
  const rows = db.prepare("SELECT json FROM records WHERE record_type = ? ORDER BY record_id").all(type) as Array<Record<string, unknown>>;
  return rows.map((row) => indexStoreRecordFromJson<T>(stringField(row, "json"), type));
}

function readIndexStoreSections(db: DatabaseSync): Array<{ id: string; paths: string[] }> {
  const rows = db.prepare("SELECT section_id, paths_json FROM sections").all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: stringField(row, "section_id") ?? "",
    paths: parseJsonStringArray(stringField(row, "paths_json")),
  }));
}

function proposalFromIndexStoreRow(row: Record<string, unknown>): ProposalRecord {
  return indexStoreRecordFromJson<ProposalRecord>(stringField(row, "json"), "proposal");
}

export function proposalTargetsPath(proposal: ProposalRecord, targetPath: string): boolean {
  return openWikiProposalTargetsPath(proposal, targetPath);
}

export function proposalSectionIds(proposal: ProposalRecord, sections: Array<{ id: string; paths: string[] }>): string[] {
  return openWikiProposalSectionIds(proposal, sections);
}

export function proposalTargetPaths(proposal: ProposalRecord): string[] {
  return openWikiProposalTargetPaths(proposal);
}

export function proposalUpdatedAt(proposal: ProposalRecord): string {
  return openWikiProposalUpdatedAt(proposal);
}

export function parseJsonStringArray(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function readMetadata(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare("SELECT key, value FROM metadata").all() as Array<{ key: string; value: string }>;
  return new Map(rows.map((row) => [row.key, row.value]));
}

export function countRows(db: DatabaseSync, table: IndexStoreCountTable): number {
  let row: { count: number | bigint } | undefined;
  switch (table) {
    case "records":
      row = db.prepare("SELECT COUNT(*) AS count FROM records").get() as { count: number | bigint };
      break;
    case "edges":
      row = db.prepare("SELECT COUNT(*) AS count FROM edges").get() as { count: number | bigint };
      break;
    case "search_documents":
      row = db.prepare("SELECT COUNT(*) AS count FROM search_documents").get() as { count: number | bigint };
      break;
    case "effective_permissions":
      row = db.prepare("SELECT COUNT(*) AS count FROM effective_permissions").get() as { count: number | bigint };
      break;
  }
  if (row === undefined) {
    return 0;
  }
  return Number(row.count);
}
