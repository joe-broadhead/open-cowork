import { redactOpenWikiGitRemoteUrl, redactOpenWikiWorkspaceConfig, type GraphEdgeRecord } from "@openwiki/core";
import { materializeEffectivePermissions } from "@openwiki/policy";
import { listGraphEdges, listTopics, type LoadedOpenWikiRepo, loadRepository } from "@openwiki/repo";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectDerivedRecords, derivedContentHash, recordGroupForDerivedRecord, searchDocumentFromRecord } from "./derived-records.ts";
import { gitCommitInfo } from "./git.ts";
import { defaultIndexStorePath } from "./paths.ts";
import { proposalUpdatedAt } from "./queries.ts";
import { json, principalTitle, principalTypeForId } from "./rows.ts";
import { schemaSql } from "./schema.ts";
import { INDEX_STORE_SCHEMA_VERSION, LOCAL_ORGANIZATION_ID, LOCAL_TENANT_ID, type DerivedRecord, type GitCommitInfo, type IndexStoreOptions, type IndexStoreRebuildResult, type SearchDocument } from "./types.ts";

export async function rebuildIndexStore(root: string, options: IndexStoreOptions = {}): Promise<IndexStoreRebuildResult> {
  const resolvedRoot = path.resolve(root);
  const dbPath = options.dbPath ?? defaultIndexStorePath(resolvedRoot);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const tmpDbPath = path.join(path.dirname(dbPath), `openwiki.${process.pid}.${Date.now()}.tmp.sqlite`);
  const repo = await loadRepository(resolvedRoot);
  const [commitInfo, graph, topics] = await Promise.all([gitCommitInfo(resolvedRoot), listGraphEdges(resolvedRoot), listTopics(resolvedRoot)]);
  const sourceCommit = commitInfo?.sha ?? "uncommitted";
  const records = collectDerivedRecords(repo, topics.topics);
  const searchDocuments = records.map(searchDocumentFromRecord);
  const contentHash = derivedContentHash(repo, records, graph.edges);
  const generatedAt = new Date().toISOString();
  const db = new DatabaseSync(tmpDbPath);

  try {
    db.exec(schemaSql());
    runSqliteTransaction(db, () => {
      insertMetadata(db, {
        schema_version: INDEX_STORE_SCHEMA_VERSION,
        generated_at: generatedAt,
        workspace_id: repo.config.workspace_id,
        source_commit: sourceCommit,
        content_hash: contentHash,
        record_count: String(records.length),
        edge_count: String(graph.edges.length),
        search_document_count: String(searchDocuments.length),
        effective_permission_count: String(materializeEffectivePermissions(repo.config, repo.policy).length),
      });
      insertWorkspacePlane(db, repo, sourceCommit, generatedAt);
      insertRecords(db, repo, records, sourceCommit, commitInfo, generatedAt);
      insertEdges(db, graph.edges, sourceCommit, generatedAt);
      insertSearchDocuments(db, searchDocuments, sourceCommit);
      insertPolicyPlane(db, repo, sourceCommit);
      insertGovernancePlane(db, repo, sourceCommit);
    });
    db.close();
    await fs.rename(tmpDbPath, dbPath);
    return {
      root: resolvedRoot,
      dbPath,
      schemaVersion: INDEX_STORE_SCHEMA_VERSION,
      sourceCommit,
      contentHash,
      recordCount: records.length,
      edgeCount: graph.edges.length,
      searchDocumentCount: searchDocuments.length,
      effectivePermissionCount: materializeEffectivePermissions(repo.config, repo.policy).length,
    };
  } finally {
    try {
      db.close();
    } catch {
      // The database may already be closed after a successful atomic rename.
    }
    await fs.rm(tmpDbPath, { force: true });
  }
}

function runSqliteTransaction(db: DatabaseSync, callback: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    callback();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original rebuild error.
    }
    throw error;
  }
}

export function insertMetadata(db: DatabaseSync, values: Record<string, string>): void {
  const insert = db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right))) {
    insert.run(key, value);
  }
}

export function insertWorkspacePlane(db: DatabaseSync, repo: LoadedOpenWikiRepo, sourceCommit: string, generatedAt: string): void {
  const redactedGit = redactedRuntimeGitConfig(repo.config.runtime?.git);
  const redactedConfig = redactOpenWikiWorkspaceConfig(repo.config);
  db.prepare("INSERT INTO organizations (organization_id, title, created_at, json) VALUES (?, ?, ?, ?)").run(
    LOCAL_ORGANIZATION_ID,
    "Local Organization",
    generatedAt,
    json({ id: LOCAL_ORGANIZATION_ID, title: "Local Organization" }),
  );
  db.prepare("INSERT INTO tenants (tenant_id, organization_id, title, created_at, json) VALUES (?, ?, ?, ?, ?)").run(
    LOCAL_TENANT_ID,
    LOCAL_ORGANIZATION_ID,
    "Local Tenant",
    generatedAt,
    json({ id: LOCAL_TENANT_ID, organization_id: LOCAL_ORGANIZATION_ID, title: "Local Tenant" }),
  );
  db
    .prepare(
      "INSERT INTO workspaces (workspace_id, tenant_id, title, repo_format, protocol_version, created_at, source_commit, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      repo.config.workspace_id,
      LOCAL_TENANT_ID,
      repo.config.title,
      repo.config.repo_format,
      repo.config.protocol_version,
      repo.config.created_at,
      sourceCommit,
      json(redactedConfig),
    );
  db
    .prepare(
      "INSERT INTO workspace_repos (workspace_id, repo_id, root_path, remote, branch, remote_url, credential_ref, source_commit, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      repo.config.workspace_id,
      "repo:default",
      repo.root,
      repo.config.runtime?.git?.remote ?? null,
      repo.config.runtime?.git?.branch ?? null,
      redactedGit.remote_url ?? null,
      repo.config.runtime?.git?.credential_ref ?? null,
      sourceCommit,
      json({ root_path: repo.root, git: redactedGit }),
    );
}

type RuntimeGitConfig = NonNullable<NonNullable<LoadedOpenWikiRepo["config"]["runtime"]>["git"]>;

interface RedactedRuntimeGitConfig {
  remote?: string;
  branch?: string;
  remote_url?: string;
  credential_ref?: string;
}

function redactedRuntimeGitConfig(git: RuntimeGitConfig | undefined): RedactedRuntimeGitConfig {
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

export function insertRecords(
  db: DatabaseSync,
  repo: LoadedOpenWikiRepo,
  records: DerivedRecord[],
  sourceCommit: string,
  commitInfo: GitCommitInfo | undefined,
  generatedAt: string,
): void {
  const insertRecord = db.prepare(
    "INSERT INTO records (workspace_id, record_id, record_type, record_group, uri, title, summary, path, status, sensitivity, created_at, updated_at, source_commit, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertPath = db.prepare(
    "INSERT INTO record_paths (workspace_id, path, record_id, record_type, source_commit) VALUES (?, ?, ?, ?, ?)",
  );
  const insertVersion = db.prepare(
    "INSERT INTO record_versions (workspace_id, record_id, commit_sha, parent_sha, author, authored_at, committer, committed_at, subject, path, change_type, json_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const versionCommit = commitInfo?.sha ?? sourceCommit;
  for (const record of records) {
    insertRecord.run(
      record.workspace_id,
      record.record_id,
      record.record_type,
      recordGroupForDerivedRecord(record),
      record.uri,
      record.title,
      record.summary,
      record.path,
      record.status,
      record.sensitivity,
      record.created_at,
      record.updated_at,
      sourceCommit,
      json(record.json),
    );
    insertPath.run(record.workspace_id, record.path, record.record_id, record.record_type, sourceCommit);
    insertVersion.run(
      record.workspace_id,
      record.record_id,
      versionCommit,
      commitInfo?.parent_sha ?? null,
      commitInfo?.author ?? null,
      commitInfo?.authored_at ?? null,
      commitInfo?.committer ?? null,
      commitInfo?.committed_at ?? null,
      commitInfo?.subject ?? "Current workspace snapshot",
      record.path,
      "snapshot",
      json(record.json),
    );
  }

  if (!records.some((record) => record.record_id === repo.config.workspace_id)) {
    insertVersion.run(
      repo.config.workspace_id,
      repo.config.workspace_id,
      versionCommit,
      commitInfo?.parent_sha ?? null,
      commitInfo?.author ?? null,
      commitInfo?.authored_at ?? null,
      commitInfo?.committer ?? null,
      commitInfo?.committed_at ?? null,
      commitInfo?.subject ?? "Current workspace snapshot",
      "openwiki.json",
      "snapshot",
      json({ generated_at: generatedAt }),
    );
  }
}

export function insertEdges(db: DatabaseSync, edges: GraphEdgeRecord[], sourceCommit: string, generatedAt: string): void {
  const insert = db.prepare(
    "INSERT INTO edges (workspace_id, edge_id, from_id, to_id, edge_type, path, anchor, weight, source_commit, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const edge of edges) {
    insert.run(
      edge.workspace_id,
      edge.id,
      edge.from_id,
      edge.to_id,
      edge.edge_type,
      edge.path ?? null,
      edge.anchor ?? null,
      edge.weight,
      edge.source_commit ?? sourceCommit,
      edge.created_at || generatedAt,
      json(edge.metadata ?? {}),
    );
  }
}

export function insertSearchDocuments(db: DatabaseSync, documents: SearchDocument[], sourceCommit: string): void {
  const insert = db.prepare(
    "INSERT INTO search_documents (workspace_id, record_id, search_text, topics_json, source_ids_json, source_commit) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const document of documents) {
    insert.run(document.workspace_id, document.record_id, document.search_text, json(document.topics), json(document.source_ids), sourceCommit);
  }
}

export function insertPolicyPlane(db: DatabaseSync, repo: LoadedOpenWikiRepo, sourceCommit: string): void {
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

  const insertPrincipal = db.prepare(
    "INSERT OR REPLACE INTO principals (principal_id, principal_type, title, source_commit, json) VALUES (?, ?, ?, ?, ?)",
  );
  const insertGroup = db.prepare("INSERT OR REPLACE INTO groups (group_id, title, source_commit, json) VALUES (?, ?, ?, ?)");
  for (const principalId of [...principalIds].sort()) {
    const principalType = principalTypeForId(principalId);
    insertPrincipal.run(principalId, principalType, principalTitle(principalId), sourceCommit, json({ id: principalId, type: principalType }));
    if (principalType === "group") {
      insertGroup.run(principalId, principalTitle(principalId), sourceCommit, json({ id: principalId }));
    }
  }

  const insertSection = db.prepare(
    "INSERT INTO sections (workspace_id, section_id, title, visibility, paths_json, owner_principal, default_reviewers_json, source_commit, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const section of repo.policy.sections) {
    insertSection.run(
      repo.config.workspace_id,
      section.id,
      section.title,
      section.visibility ?? "public",
      json(section.paths),
      section.owner_principal ?? null,
      json(section.default_reviewers ?? []),
      sourceCommit,
      json(section),
    );
  }

  const insertGrant = db.prepare(
    "INSERT INTO grants (workspace_id, principal_id, section_id, role, source_commit, json) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertEffective = db.prepare(
    "INSERT INTO effective_permissions (workspace_id, principal_id, section_id, role, scopes_json, source_commit) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const effectivePermissions = materializeEffectivePermissions(repo.config, repo.policy);
  for (const grant of repo.policy.grants) {
    insertGrant.run(repo.config.workspace_id, grant.principal, grant.section, grant.role, sourceCommit, json(grant));
  }
  for (const permission of effectivePermissions) {
    insertEffective.run(repo.config.workspace_id, permission.principal, permission.section, permission.role, json(permission.scopes), sourceCommit);
  }

  if (repo.policy.grants.length === 0) {
    db.prepare("INSERT INTO principals (principal_id, principal_type, title, source_commit, json) VALUES (?, ?, ?, ?, ?)").run(
      "group:all-users",
      "group",
      "all-users",
      sourceCommit,
      json({ id: "group:all-users", type: "group" }),
    );
  }
}

export function insertGovernancePlane(db: DatabaseSync, repo: LoadedOpenWikiRepo, sourceCommit: string): void {
  const insertProposal = db.prepare(
    "INSERT INTO proposals (workspace_id, proposal_id, status, actor_id, target_path, target_ids_json, created_at, updated_at, source_commit, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const proposal of repo.proposals) {
    insertProposal.run(
      repo.config.workspace_id,
      proposal.id,
      proposal.status,
      proposal.actor_id,
      proposal.target_path ?? null,
      json(proposal.target_ids),
      proposal.created_at,
      proposalUpdatedAt(proposal),
      sourceCommit,
      json(proposal),
    );
  }

  const insertReview = db.prepare(
    "INSERT INTO proposal_reviews (workspace_id, review_id, proposal_id, actor_id, decision, rationale, decided_at, source_commit, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertDecision = db.prepare(
    "INSERT INTO decisions (workspace_id, decision_id, proposal_id, decision, actor_id, decided_at, source_commit, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const decision of repo.decisions) {
    insertReview.run(repo.config.workspace_id, decision.id, decision.proposal_id, decision.actor_id, decision.decision, decision.rationale, decision.decided_at, sourceCommit, json(decision));
    insertDecision.run(repo.config.workspace_id, decision.id, decision.proposal_id, decision.decision, decision.actor_id, decision.decided_at, sourceCommit, json(decision));
  }

  const insertEvent = db.prepare(
    "INSERT INTO events (workspace_id, event_id, event_type, actor_id, operation, record_id, occurred_at, sensitivity, source_commit, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const event of repo.events) {
    insertEvent.run(
      repo.config.workspace_id,
      event.id,
      event.type,
      event.actor_id ?? null,
      event.operation ?? null,
      event.record_id ?? null,
      event.occurred_at,
      event.sensitivity ?? null,
      sourceCommit,
      json(event),
    );
  }

  const insertRun = db.prepare(
    "INSERT INTO runs (workspace_id, run_id, run_type, status, actor_id, created_at, completed_at, source_commit, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertJob = db.prepare(
    "INSERT INTO jobs (workspace_id, job_id, run_id, job_type, status, actor_id, created_at, source_commit, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const run of repo.runs) {
    insertRun.run(repo.config.workspace_id, run.id, run.run_type, run.status, run.actor_id, run.created_at, run.completed_at ?? null, sourceCommit, json(run));
    if (run.status === "queued") {
      insertJob.run(repo.config.workspace_id, run.id, run.id, run.run_type, run.status, run.actor_id, run.created_at, sourceCommit, json(run));
    }
  }

  const insertSourceObject = db.prepare(
    "INSERT INTO source_objects (workspace_id, source_id, storage_json, content_hash, url, path, source_commit, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const source of repo.sources) {
    insertSourceObject.run(
      repo.config.workspace_id,
      source.id,
      json(source.storage ?? {}),
      source.content_hash ?? null,
      source.url ?? null,
      source.path,
      sourceCommit,
      json(source),
    );
  }
}
