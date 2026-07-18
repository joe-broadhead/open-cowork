import { redactOpenWikiGitRemoteUrl, redactOpenWikiWorkspaceConfig, type GraphEdgeRecord, uniqueStrings } from "@openwiki/core";
import { materializeEffectivePermissions, sanitizeServiceAccount } from "@openwiki/policy";
import type { LoadedOpenWikiRepo } from "@openwiki/repo";
import { contentPathChangesTopics } from "./derived-records.ts";
import { jsonb, postgresJsonValue, principalTitle, principalTypeForId } from "./rows.ts";
import { proposalUpdatedAt } from "./search.ts";
import { POSTGRES_IMPORT_BATCH_SIZE, type DerivedRecord, type PostgresQuery, type SearchDocument } from "./types.ts";
import { createHash } from "node:crypto";

const POSTGRES_SEARCH_CHUNK_MAX_CHARACTERS = 1200;
const POSTGRES_SEARCH_CHUNK_OVERLAP_CHARACTERS = 120;

export async function clearWorkspaceRuntimeRows(sql: PostgresQuery, workspaceId: string): Promise<void> {
  await sql`DELETE FROM runtime_metadata WHERE workspace_id = ${workspaceId}`;
  await clearWorkspaceGovernanceRows(sql, workspaceId);
  await sql`DELETE FROM service_accounts WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM principal_groups WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM groups WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM principals WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM effective_permissions WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM grants WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM sections WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM search_chunk_embeddings WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM search_chunks WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM search_documents WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM edges WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM record_paths WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM record_versions WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM records WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspace_repos WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE workspace_id = ${workspaceId}`;
}

export async function clearWorkspaceGovernanceRows(sql: PostgresQuery, workspaceId: string): Promise<void> {
  await sql`DELETE FROM source_objects WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM runs WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM decisions WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM proposal_reviews WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM proposals WHERE workspace_id = ${workspaceId}`;
}

export async function upsertWorkspacePlane(sql: PostgresQuery, repo: LoadedOpenWikiRepo, sourceCommit: string): Promise<void> {
  await insertWorkspacePlane(sql, repo, sourceCommit);
}

export async function upsertRecords(sql: PostgresQuery, records: DerivedRecord[], sourceCommit: string): Promise<void> {
  await insertRecords(sql, records, sourceCommit);
}

export async function refreshEdges(sql: PostgresQuery, workspaceId: string, edges: GraphEdgeRecord[], sourceCommit: string): Promise<void> {
  await sql`DELETE FROM edges WHERE workspace_id = ${workspaceId}`;
  await insertEdges(sql, edges, sourceCommit);
}

export async function refreshEdgesForChangedPaths(
  sql: PostgresQuery,
  workspaceId: string,
  edges: GraphEdgeRecord[],
  changedPaths: string[],
  sourceCommit: string,
): Promise<void> {
  const paths = uniqueStrings(changedPaths, { omitEmpty: true });
  if (paths.length === 0) {
    return;
  }
  await sql`DELETE FROM edges WHERE workspace_id = ${workspaceId} AND path IN ${sql(paths)}`;
  await insertEdges(sql, edges.filter((edge) => edge.path !== undefined && paths.includes(edge.path)), sourceCommit);
}

export async function refreshSearchDocuments(sql: PostgresQuery, workspaceId: string, documents: SearchDocument[], sourceCommit: string): Promise<void> {
  if (documents.length > 0) {
    const recordIds = documents.map((document) => document.record_id);
    await sql`DELETE FROM search_chunk_embeddings WHERE workspace_id = ${workspaceId} AND record_id IN ${sql(recordIds)}`;
    await sql`DELETE FROM search_chunks WHERE workspace_id = ${workspaceId} AND record_id IN ${sql(recordIds)}`;
    await sql`DELETE FROM search_documents WHERE workspace_id = ${workspaceId} AND record_id IN ${sql(recordIds)}`;
  }
  await insertSearchDocuments(sql, documents, sourceCommit);
}

export async function refreshPolicyPlane(sql: PostgresQuery, repo: LoadedOpenWikiRepo, sourceCommit: string): Promise<void> {
  await sql`DELETE FROM effective_permissions WHERE workspace_id = ${repo.config.workspace_id}`;
  await sql`DELETE FROM grants WHERE workspace_id = ${repo.config.workspace_id}`;
  await sql`DELETE FROM sections WHERE workspace_id = ${repo.config.workspace_id}`;
  await sql`DELETE FROM service_accounts WHERE workspace_id = ${repo.config.workspace_id}`;
  await insertPolicyPlane(sql, repo, sourceCommit);
}

export async function refreshGovernancePlane(sql: PostgresQuery, repo: LoadedOpenWikiRepo, sourceCommit: string): Promise<void> {
  await clearWorkspaceGovernanceRows(sql, repo.config.workspace_id);
  await insertGovernancePlane(sql, repo, sourceCommit);
}

export async function deleteRecordsForChangedPaths(
  sql: PostgresQuery,
  workspaceId: string,
  changedPaths: string[],
  affectedRecordIds: string[],
): Promise<void> {
  const oldRows: Array<{ record_id: string }> = changedPaths.length === 0
    ? []
    : await sql<Array<{ record_id: string }>>`
        SELECT DISTINCT record_id
        FROM record_paths
        WHERE workspace_id = ${workspaceId} AND path IN ${sql(changedPaths)}
      `;
  const oldTopicRows: Array<{ record_id: string }> = changedPaths.some((changedPath) => contentPathChangesTopics(changedPath))
    ? await sql<Array<{ record_id: string }>>`
        SELECT DISTINCT record_id
        FROM records
        WHERE workspace_id = ${workspaceId} AND record_type = 'topic'
      `
    : [];
  const ids = [...new Set([...affectedRecordIds, ...oldRows.map((row) => row.record_id), ...oldTopicRows.map((row) => row.record_id)])].sort();
  if (ids.length === 0) {
    return;
  }
  await sql`DELETE FROM search_chunk_embeddings WHERE workspace_id = ${workspaceId} AND record_id IN ${sql(ids)}`;
  await sql`DELETE FROM search_chunks WHERE workspace_id = ${workspaceId} AND record_id IN ${sql(ids)}`;
  await sql`DELETE FROM search_documents WHERE workspace_id = ${workspaceId} AND record_id IN ${sql(ids)}`;
  await sql`DELETE FROM record_versions WHERE workspace_id = ${workspaceId} AND record_id IN ${sql(ids)}`;
  await sql`DELETE FROM record_paths WHERE workspace_id = ${workspaceId} AND record_id IN ${sql(ids)}`;
  await sql`DELETE FROM records WHERE workspace_id = ${workspaceId} AND record_id IN ${sql(ids)}`;
}

export async function upsertRuntimeMetadata(sql: PostgresQuery, workspaceId: string, values: Record<string, string>): Promise<void> {
  const updatedAt = new Date().toISOString();
  for (const [key, value] of Object.entries(values)) {
    await sql`
      INSERT INTO runtime_metadata (workspace_id, key, value, updated_at)
      VALUES (${workspaceId}, ${key}, ${value}, ${updatedAt})
      ON CONFLICT (workspace_id, key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = EXCLUDED.updated_at
    `;
  }
}

export function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export async function insertWorkspacePlane(sql: PostgresQuery, repo: LoadedOpenWikiRepo, sourceCommit: string): Promise<void> {
  const organizationId = "organization:local";
  const tenantId = "tenant:local";
  const generatedAt = new Date().toISOString();
  const redactedGit = redactedRuntimeGitConfig(repo.config.runtime?.git);
  const redactedConfig = redactOpenWikiWorkspaceConfig(repo.config);
  await sql`
    INSERT INTO organizations (organization_id, title, created_at, json)
    VALUES (${organizationId}, ${"Local Organization"}, ${generatedAt}, ${jsonb({ id: organizationId, title: "Local Organization" })}::jsonb)
    ON CONFLICT (organization_id) DO UPDATE SET title = EXCLUDED.title, json = EXCLUDED.json
  `;
  await sql`
    INSERT INTO tenants (tenant_id, organization_id, title, created_at, json)
    VALUES (${tenantId}, ${organizationId}, ${"Local Tenant"}, ${generatedAt}, ${jsonb({ id: tenantId, organization_id: organizationId, title: "Local Tenant" })}::jsonb)
    ON CONFLICT (tenant_id) DO UPDATE SET organization_id = EXCLUDED.organization_id, title = EXCLUDED.title, json = EXCLUDED.json
  `;
  await sql`
    INSERT INTO workspaces (workspace_id, tenant_id, title, repo_format, protocol_version, created_at, source_commit, json)
    VALUES (
      ${repo.config.workspace_id}, ${tenantId}, ${repo.config.title}, ${repo.config.repo_format}, ${repo.config.protocol_version},
      ${repo.config.created_at}, ${sourceCommit}, ${jsonb(redactedConfig)}::jsonb
    )
    ON CONFLICT (workspace_id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      title = EXCLUDED.title,
      repo_format = EXCLUDED.repo_format,
      protocol_version = EXCLUDED.protocol_version,
      source_commit = EXCLUDED.source_commit,
      json = EXCLUDED.json
  `;
  await sql`
    INSERT INTO workspace_repos (workspace_id, repo_id, root_path, remote, branch, remote_url, credential_ref, source_commit, json)
    VALUES (
      ${repo.config.workspace_id}, ${"repo:default"}, ${repo.root}, ${repo.config.runtime?.git?.remote ?? null},
      ${repo.config.runtime?.git?.branch ?? null}, ${redactedGit.remote_url ?? null},
      ${repo.config.runtime?.git?.credential_ref ?? null}, ${sourceCommit}, ${jsonb({ root_path: repo.root, git: redactedGit })}::jsonb
    )
    ON CONFLICT (workspace_id, repo_id) DO UPDATE SET
      root_path = EXCLUDED.root_path,
      remote = EXCLUDED.remote,
      branch = EXCLUDED.branch,
      remote_url = EXCLUDED.remote_url,
      credential_ref = EXCLUDED.credential_ref,
      source_commit = EXCLUDED.source_commit,
      json = EXCLUDED.json
  `;
}

type RuntimeGitConfig = NonNullable<NonNullable<LoadedOpenWikiRepo["config"]["runtime"]>["git"]>;

function redactedRuntimeGitConfig(git: RuntimeGitConfig | undefined): Record<string, unknown> {
  if (git === undefined) {
    return {};
  }
  return {
    ...(git.remote === undefined ? {} : { remote: git.remote }),
    ...(git.branch === undefined ? {} : { branch: git.branch }),
    ...(git.remote_url === undefined ? {} : { remote_url: redactOpenWikiGitRemoteUrl(git.remote_url) }),
    ...(git.credential_ref === undefined ? {} : { credential_ref: git.credential_ref }),
  };
}

export async function insertRecords(sql: PostgresQuery, records: DerivedRecord[], sourceCommit: string): Promise<void> {
  for (const batch of chunks(records, POSTGRES_IMPORT_BATCH_SIZE)) {
    await sql`
      INSERT INTO records
      ${sql(batch.map((record) => ({
        workspace_id: record.workspace_id,
        record_id: record.record_id,
        record_type: record.record_type,
        uri: record.uri,
        title: record.title,
        summary: record.summary,
        path: record.path,
        status: record.status,
        sensitivity: record.sensitivity ?? null,
        created_at: record.created_at,
        updated_at: record.updated_at,
        source_commit: sourceCommit,
        json: sql.json(postgresJsonValue(record.json)),
      })), "workspace_id", "record_id", "record_type", "uri", "title", "summary", "path", "status", "sensitivity", "created_at", "updated_at", "source_commit", "json")}
      ON CONFLICT (workspace_id, record_id) DO UPDATE SET
        record_type = EXCLUDED.record_type,
        uri = EXCLUDED.uri,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        path = EXCLUDED.path,
        status = EXCLUDED.status,
        sensitivity = EXCLUDED.sensitivity,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        source_commit = EXCLUDED.source_commit,
        json = EXCLUDED.json
    `;
    await sql`
      INSERT INTO record_paths
      ${sql(batch.map((record) => ({
        workspace_id: record.workspace_id,
        path: record.path,
        record_id: record.record_id,
        record_type: record.record_type,
        source_commit: sourceCommit,
      })), "workspace_id", "path", "record_id", "record_type", "source_commit")}
      ON CONFLICT (workspace_id, path, record_id) DO UPDATE SET
        record_type = EXCLUDED.record_type,
        source_commit = EXCLUDED.source_commit
    `;
    await sql`
      INSERT INTO record_versions
      ${sql(batch.map((record) => ({
        workspace_id: record.workspace_id,
        record_id: record.record_id,
        commit_sha: sourceCommit,
        parent_sha: null,
        author: null,
        authored_at: null,
        committer: null,
        committed_at: null,
        subject: "Current workspace snapshot",
        path: record.path,
        change_type: "snapshot",
        json_snapshot: sql.json(postgresJsonValue(record.json)),
      })), "workspace_id", "record_id", "commit_sha", "parent_sha", "author", "authored_at", "committer", "committed_at", "subject", "path", "change_type", "json_snapshot")}
      ON CONFLICT (workspace_id, record_id, commit_sha) DO UPDATE SET
        path = EXCLUDED.path,
        change_type = EXCLUDED.change_type,
        json_snapshot = EXCLUDED.json_snapshot
    `;
  }
}

export async function insertEdges(sql: PostgresQuery, edges: GraphEdgeRecord[], sourceCommit: string): Promise<void> {
  const generatedAt = new Date().toISOString();
  for (const batch of chunks(edges, POSTGRES_IMPORT_BATCH_SIZE)) {
    await sql`
      INSERT INTO edges
      ${sql(batch.map((edge) => ({
        workspace_id: edge.workspace_id,
        edge_id: edge.id,
        from_id: edge.from_id,
        to_id: edge.to_id,
        edge_type: edge.edge_type,
        path: edge.path ?? null,
        anchor: edge.anchor ?? null,
        weight: edge.weight,
        source_commit: edge.source_commit ?? sourceCommit,
        created_at: edge.created_at || generatedAt,
        metadata: sql.json(postgresJsonValue(edge.metadata ?? {})),
      })), "workspace_id", "edge_id", "from_id", "to_id", "edge_type", "path", "anchor", "weight", "source_commit", "created_at", "metadata")}
      ON CONFLICT (workspace_id, edge_id) DO UPDATE SET
        from_id = EXCLUDED.from_id,
        to_id = EXCLUDED.to_id,
        edge_type = EXCLUDED.edge_type,
        path = EXCLUDED.path,
        anchor = EXCLUDED.anchor,
        weight = EXCLUDED.weight,
        source_commit = EXCLUDED.source_commit,
        created_at = EXCLUDED.created_at,
        metadata = EXCLUDED.metadata
    `;
  }
}

export async function insertSearchDocuments(sql: PostgresQuery, documents: SearchDocument[], sourceCommit: string): Promise<void> {
  for (const batch of chunks(documents, POSTGRES_IMPORT_BATCH_SIZE)) {
    await sql`
      INSERT INTO search_documents
      ${sql(batch.map((document) => ({
        workspace_id: document.workspace_id,
        record_id: document.record_id,
        search_text: document.search_text,
        topics_json: sql.json(postgresJsonValue(document.topics)),
        source_ids_json: sql.json(postgresJsonValue(document.source_ids)),
        source_commit: sourceCommit,
      })), "workspace_id", "record_id", "search_text", "topics_json", "source_ids_json", "source_commit")}
      ON CONFLICT (workspace_id, record_id) DO UPDATE SET
        search_text = EXCLUDED.search_text,
        topics_json = EXCLUDED.topics_json,
        source_ids_json = EXCLUDED.source_ids_json,
        source_commit = EXCLUDED.source_commit
    `;
  }
  await insertSearchChunks(sql, documents, sourceCommit);
}

export async function insertSearchChunks(sql: PostgresQuery, documents: SearchDocument[], sourceCommit: string): Promise<void> {
  const generatedAt = new Date().toISOString();
  const searchChunks = documents.flatMap((document) => searchChunksFromDocument(document, sourceCommit, generatedAt));
  for (const batch of chunks(searchChunks, POSTGRES_IMPORT_BATCH_SIZE)) {
    await sql`
      INSERT INTO search_chunks
      ${sql(batch.map((chunk) => ({
        workspace_id: chunk.workspace_id,
        chunk_id: chunk.chunk_id,
        record_id: chunk.record_id,
        record_type: chunk.record_type,
        path: chunk.path,
        ordinal: chunk.ordinal,
        text: chunk.text,
        content_hash: chunk.content_hash,
        character_count: chunk.character_count,
        token_count: chunk.token_count,
        source_ids_json: sql.json(postgresJsonValue(chunk.source_ids)),
        source_commit: chunk.source_commit,
        updated_at: chunk.updated_at,
      })), "workspace_id", "chunk_id", "record_id", "record_type", "path", "ordinal", "text", "content_hash", "character_count", "token_count", "source_ids_json", "source_commit", "updated_at")}
      ON CONFLICT (workspace_id, chunk_id) DO UPDATE SET
        record_id = EXCLUDED.record_id,
        record_type = EXCLUDED.record_type,
        path = EXCLUDED.path,
        ordinal = EXCLUDED.ordinal,
        text = EXCLUDED.text,
        content_hash = EXCLUDED.content_hash,
        character_count = EXCLUDED.character_count,
        token_count = EXCLUDED.token_count,
        source_ids_json = EXCLUDED.source_ids_json,
        source_commit = EXCLUDED.source_commit,
        updated_at = EXCLUDED.updated_at
    `;
  }
}

interface PostgresSearchChunk {
  workspace_id: string;
  chunk_id: string;
  record_id: string;
  record_type: string;
  path: string;
  ordinal: number;
  text: string;
  content_hash: string;
  character_count: number;
  token_count: number;
  source_ids: string[];
  source_commit: string;
  updated_at: string;
}

function searchChunksFromDocument(document: SearchDocument, sourceCommit: string, generatedAt: string): PostgresSearchChunk[] {
  const text = document.search_text.replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return [];
  }
  const chunks: PostgresSearchChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + POSTGRES_SEARCH_CHUNK_MAX_CHARACTERS, text.length);
    const chunkText = text.slice(start, end).trim();
    if (chunkText.length > 0) {
      chunks.push({
        workspace_id: document.workspace_id,
        chunk_id: `chunk:${document.record_id}:${String(chunks.length + 1).padStart(4, "0")}`,
        record_id: document.record_id,
        record_type: document.record_type,
        path: document.path,
        ordinal: chunks.length,
        text: chunkText,
        content_hash: `sha256:${createHash("sha256").update(chunkText).digest("hex")}`,
        character_count: chunkText.length,
        token_count: chunkText.split(/\s+/).filter(Boolean).length,
        source_ids: document.source_ids,
        source_commit: sourceCommit,
        updated_at: generatedAt,
      });
    }
    if (end >= text.length) {
      break;
    }
    start = Math.max(end - POSTGRES_SEARCH_CHUNK_OVERLAP_CHARACTERS, start + 1);
  }
  return chunks;
}

export async function insertPolicyPlane(sql: PostgresQuery, repo: LoadedOpenWikiRepo, sourceCommit: string): Promise<void> {
  const principalIds = new Set<string>();
  for (const grant of repo.policy.grants) {
    principalIds.add(grant.principal);
  }
  for (const account of repo.config.auth?.service_accounts ?? []) {
    principalIds.add(account.id);
    principalIds.add(account.actor_id);
    for (const principal of account.principals ?? []) {
      principalIds.add(principal);
    }
  }
  if (principalIds.size === 0) {
    principalIds.add("group:all-users");
  }
  for (const principalId of [...principalIds].sort()) {
    const type = principalTypeForId(principalId);
    await sql`
      INSERT INTO principals (workspace_id, principal_id, principal_type, title, source_commit, json)
      VALUES (${repo.config.workspace_id}, ${principalId}, ${type}, ${principalTitle(principalId)}, ${sourceCommit}, ${jsonb({ id: principalId, type })}::jsonb)
      ON CONFLICT (workspace_id, principal_id) DO UPDATE SET principal_type = EXCLUDED.principal_type, title = EXCLUDED.title, source_commit = EXCLUDED.source_commit, json = EXCLUDED.json
    `;
    if (type === "group") {
      await sql`
        INSERT INTO groups (workspace_id, group_id, title, source_commit, json)
        VALUES (${repo.config.workspace_id}, ${principalId}, ${principalTitle(principalId)}, ${sourceCommit}, ${jsonb({ id: principalId })}::jsonb)
        ON CONFLICT (workspace_id, group_id) DO UPDATE SET title = EXCLUDED.title, source_commit = EXCLUDED.source_commit, json = EXCLUDED.json
      `;
    }
  }
  for (const account of repo.config.auth?.service_accounts ?? []) {
    const sanitized = sanitizeServiceAccount(account);
    const scopes = uniqueStrings(sanitized.scopes, { omitEmpty: true });
    const principals = uniqueStrings(sanitized.principals, { omitEmpty: true });
    await sql`
      INSERT INTO service_accounts (workspace_id, service_account_id, actor_id, role, scopes_json, principals_json, token_hash_count, source_commit, json)
      VALUES (${repo.config.workspace_id}, ${account.id}, ${account.actor_id}, ${account.role ?? null}, ${jsonb(scopes)}::jsonb, ${jsonb(principals)}::jsonb, ${sanitized.token_hash_count}, ${sourceCommit}, ${jsonb(sanitized)}::jsonb)
      ON CONFLICT (workspace_id, service_account_id) DO UPDATE SET
        actor_id = EXCLUDED.actor_id,
        role = EXCLUDED.role,
        scopes_json = EXCLUDED.scopes_json,
        principals_json = EXCLUDED.principals_json,
        token_hash_count = EXCLUDED.token_hash_count,
        source_commit = EXCLUDED.source_commit,
        json = EXCLUDED.json
    `;
    await sql`
      INSERT INTO principals (workspace_id, principal_id, principal_type, title, source_commit, json)
      VALUES (${repo.config.workspace_id}, ${account.id}, ${"service_account"}, ${principalTitle(account.id)}, ${sourceCommit}, ${jsonb({ id: account.id, type: "service_account" })}::jsonb)
      ON CONFLICT (workspace_id, principal_id) DO UPDATE SET principal_type = EXCLUDED.principal_type, title = EXCLUDED.title, source_commit = EXCLUDED.source_commit, json = EXCLUDED.json
    `;
    for (const principal of principals.filter((entry) => entry.startsWith("group:"))) {
      await sql`
        INSERT INTO principal_groups (workspace_id, principal_id, group_id, source_commit)
        VALUES (${repo.config.workspace_id}, ${account.actor_id}, ${principal}, ${sourceCommit})
        ON CONFLICT (workspace_id, principal_id, group_id) DO UPDATE SET source_commit = EXCLUDED.source_commit
      `;
    }
  }
  for (const section of repo.policy.sections) {
    await sql`
      INSERT INTO sections (workspace_id, section_id, title, visibility, paths_json, owner_principal, default_reviewers_json, source_commit, json)
      VALUES (${repo.config.workspace_id}, ${section.id}, ${section.title}, ${section.visibility ?? "public"}, ${jsonb(section.paths)}::jsonb, ${section.owner_principal ?? null}, ${jsonb(section.default_reviewers ?? [])}::jsonb, ${sourceCommit}, ${jsonb(section)}::jsonb)
      ON CONFLICT (workspace_id, section_id) DO UPDATE SET
        title = EXCLUDED.title,
        visibility = EXCLUDED.visibility,
        paths_json = EXCLUDED.paths_json,
        owner_principal = EXCLUDED.owner_principal,
        default_reviewers_json = EXCLUDED.default_reviewers_json,
        source_commit = EXCLUDED.source_commit,
        json = EXCLUDED.json
    `;
  }
  const effectivePermissions = materializeEffectivePermissions(repo.config, repo.policy);
  for (const grant of repo.policy.grants) {
    await sql`
      INSERT INTO grants (workspace_id, principal_id, section_id, role, source_commit, json)
      VALUES (${repo.config.workspace_id}, ${grant.principal}, ${grant.section}, ${grant.role}, ${sourceCommit}, ${jsonb(grant)}::jsonb)
      ON CONFLICT (workspace_id, principal_id, section_id) DO UPDATE SET
        role = EXCLUDED.role,
        source_commit = EXCLUDED.source_commit,
        json = EXCLUDED.json
    `;
  }
  for (const permission of effectivePermissions) {
    await sql`
      INSERT INTO effective_permissions (workspace_id, principal_id, section_id, role, scopes_json, source_commit)
      VALUES (${repo.config.workspace_id}, ${permission.principal}, ${permission.section}, ${permission.role}, ${jsonb(permission.scopes)}::jsonb, ${sourceCommit})
      ON CONFLICT (workspace_id, principal_id, section_id) DO UPDATE SET
        role = EXCLUDED.role,
        scopes_json = EXCLUDED.scopes_json,
        source_commit = EXCLUDED.source_commit
    `;
  }
}

export async function insertGovernancePlane(sql: PostgresQuery, repo: LoadedOpenWikiRepo, sourceCommit: string): Promise<void> {
  for (const proposal of repo.proposals) {
    await sql`
      INSERT INTO proposals (workspace_id, proposal_id, status, actor_id, target_path, target_ids_json, created_at, updated_at, source_commit, json)
      VALUES (${repo.config.workspace_id}, ${proposal.id}, ${proposal.status}, ${proposal.actor_id}, ${proposal.target_path ?? null}, ${jsonb(proposal.target_ids)}::jsonb, ${proposal.created_at}, ${proposalUpdatedAt(proposal)}, ${sourceCommit}, ${jsonb(proposal)}::jsonb)
      ON CONFLICT (workspace_id, proposal_id) DO UPDATE SET
        status = EXCLUDED.status,
        actor_id = EXCLUDED.actor_id,
        target_path = EXCLUDED.target_path,
        target_ids_json = EXCLUDED.target_ids_json,
        updated_at = EXCLUDED.updated_at,
        source_commit = EXCLUDED.source_commit,
        json = EXCLUDED.json
    `;
  }
  for (const decision of repo.decisions) {
    await sql`
      INSERT INTO proposal_reviews (workspace_id, review_id, proposal_id, actor_id, decision, rationale, decided_at, source_commit, json)
      VALUES (${repo.config.workspace_id}, ${decision.id}, ${decision.proposal_id}, ${decision.actor_id}, ${decision.decision}, ${decision.rationale}, ${decision.decided_at}, ${sourceCommit}, ${jsonb(decision)}::jsonb)
      ON CONFLICT (workspace_id, review_id) DO UPDATE SET
        proposal_id = EXCLUDED.proposal_id,
        actor_id = EXCLUDED.actor_id,
        decision = EXCLUDED.decision,
        rationale = EXCLUDED.rationale,
        decided_at = EXCLUDED.decided_at,
        source_commit = EXCLUDED.source_commit,
        json = EXCLUDED.json
    `;
    await sql`
      INSERT INTO decisions (workspace_id, decision_id, proposal_id, decision, actor_id, decided_at, source_commit, json)
      VALUES (${repo.config.workspace_id}, ${decision.id}, ${decision.proposal_id}, ${decision.decision}, ${decision.actor_id}, ${decision.decided_at}, ${sourceCommit}, ${jsonb(decision)}::jsonb)
      ON CONFLICT (workspace_id, decision_id) DO UPDATE SET
        proposal_id = EXCLUDED.proposal_id,
        decision = EXCLUDED.decision,
        actor_id = EXCLUDED.actor_id,
        decided_at = EXCLUDED.decided_at,
        source_commit = EXCLUDED.source_commit,
        json = EXCLUDED.json
    `;
  }
  for (const event of repo.events) {
    await sql`
      INSERT INTO events (workspace_id, event_id, event_type, actor_id, operation, record_id, occurred_at, sensitivity, source_commit, json)
      VALUES (${repo.config.workspace_id}, ${event.id}, ${event.type}, ${event.actor_id ?? null}, ${event.operation ?? null}, ${event.record_id ?? null}, ${event.occurred_at}, ${event.sensitivity ?? null}, ${sourceCommit}, ${jsonb(event)}::jsonb)
      ON CONFLICT (workspace_id, event_id) DO UPDATE SET
        event_type = EXCLUDED.event_type,
        actor_id = EXCLUDED.actor_id,
        operation = EXCLUDED.operation,
        record_id = EXCLUDED.record_id,
        occurred_at = EXCLUDED.occurred_at,
        sensitivity = EXCLUDED.sensitivity,
        source_commit = EXCLUDED.source_commit,
        json = EXCLUDED.json
    `;
  }
  for (const run of repo.runs) {
    await sql`
      INSERT INTO runs (workspace_id, run_id, run_type, status, actor_id, created_at, started_at, completed_at, source_commit, json)
      VALUES (${repo.config.workspace_id}, ${run.id}, ${run.run_type}, ${run.status}, ${run.actor_id}, ${run.created_at}, ${run.started_at ?? null}, ${run.completed_at ?? null}, ${sourceCommit}, ${jsonb(run)}::jsonb)
      ON CONFLICT (workspace_id, run_id) DO UPDATE SET
        run_type = EXCLUDED.run_type,
        status = EXCLUDED.status,
        actor_id = EXCLUDED.actor_id,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        source_commit = EXCLUDED.source_commit,
        json = EXCLUDED.json
    `;
    if (run.status === "queued") {
      await sql`
        INSERT INTO jobs (workspace_id, job_id, run_id, job_type, status, actor_id, created_at, source_commit, json)
        VALUES (${repo.config.workspace_id}, ${run.id}, ${run.id}, ${run.run_type}, ${run.status}, ${run.actor_id}, ${run.created_at}, ${sourceCommit}, ${jsonb(run)}::jsonb)
        ON CONFLICT (workspace_id, job_id) DO UPDATE SET
          run_id = EXCLUDED.run_id,
          job_type = EXCLUDED.job_type,
          status = EXCLUDED.status,
          actor_id = EXCLUDED.actor_id,
          source_commit = EXCLUDED.source_commit,
          json = EXCLUDED.json
      `;
    }
  }
  for (const source of repo.sources) {
    await sql`
      INSERT INTO source_objects (workspace_id, source_id, storage_json, content_hash, url, path, source_commit, json)
      VALUES (${repo.config.workspace_id}, ${source.id}, ${jsonb(source.storage ?? {})}::jsonb, ${source.content_hash ?? null}, ${source.url ?? null}, ${source.path}, ${sourceCommit}, ${jsonb(source)}::jsonb)
      ON CONFLICT (workspace_id, source_id) DO UPDATE SET
        storage_json = EXCLUDED.storage_json,
        content_hash = EXCLUDED.content_hash,
        url = EXCLUDED.url,
        path = EXCLUDED.path,
        source_commit = EXCLUDED.source_commit,
        json = EXCLUDED.json
    `;
  }
}
