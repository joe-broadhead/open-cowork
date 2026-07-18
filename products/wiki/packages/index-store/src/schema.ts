
export function schemaSql(): string {
  return `
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE organizations (
      organization_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE tenants (
      tenant_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE workspaces (
      workspace_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      title TEXT NOT NULL,
      repo_format TEXT NOT NULL,
      protocol_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE workspace_repos (
      workspace_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      remote TEXT,
      branch TEXT,
      remote_url TEXT,
      credential_ref TEXT,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, repo_id)
    );

    CREATE TABLE records (
      workspace_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      record_group TEXT NOT NULL,
      uri TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      path TEXT NOT NULL,
      status TEXT NOT NULL,
      sensitivity TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, record_id)
    );

    CREATE TABLE record_versions (
      workspace_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      parent_sha TEXT,
      author TEXT,
      authored_at TEXT,
      committer TEXT,
      committed_at TEXT,
      subject TEXT,
      path TEXT NOT NULL,
      change_type TEXT NOT NULL,
      json_snapshot TEXT NOT NULL,
      PRIMARY KEY (workspace_id, record_id, commit_sha)
    );

    CREATE TABLE record_paths (
      workspace_id TEXT NOT NULL,
      path TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      PRIMARY KEY (workspace_id, path, record_id)
    );

    CREATE TABLE edges (
      workspace_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      path TEXT,
      anchor TEXT,
      weight REAL NOT NULL,
      source_commit TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata TEXT NOT NULL,
      PRIMARY KEY (workspace_id, edge_id)
    );

    CREATE TABLE search_documents (
      workspace_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      search_text TEXT NOT NULL,
      topics_json TEXT NOT NULL,
      source_ids_json TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      PRIMARY KEY (workspace_id, record_id)
    );

    CREATE TABLE principals (
      principal_id TEXT PRIMARY KEY,
      principal_type TEXT NOT NULL,
      title TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE groups (
      group_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE principal_groups (
      principal_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      PRIMARY KEY (principal_id, group_id)
    );

    CREATE TABLE sections (
      workspace_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      title TEXT NOT NULL,
      visibility TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      owner_principal TEXT,
      default_reviewers_json TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, section_id)
    );

    CREATE TABLE grants (
      workspace_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      role TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, principal_id, section_id)
    );

    CREATE TABLE effective_permissions (
      workspace_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      role TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      PRIMARY KEY (workspace_id, principal_id, section_id)
    );

    CREATE TABLE proposals (
      workspace_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      status TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      target_path TEXT,
      target_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, proposal_id)
    );

    CREATE TABLE proposal_reviews (
      workspace_id TEXT NOT NULL,
      review_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      rationale TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, review_id)
    );

    CREATE TABLE decisions (
      workspace_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, decision_id)
    );

    CREATE TABLE events (
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_id TEXT,
      operation TEXT,
      record_id TEXT,
      occurred_at TEXT NOT NULL,
      sensitivity TEXT,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, event_id)
    );

    CREATE TABLE runs (
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, run_id)
    );

    CREATE TABLE jobs (
      workspace_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, job_id)
    );

    CREATE TABLE source_objects (
      workspace_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      storage_json TEXT NOT NULL,
      content_hash TEXT,
      url TEXT,
      path TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, source_id)
    );

    CREATE INDEX records_type_idx ON records (workspace_id, record_type, status);
    CREATE INDEX records_group_idx ON records (workspace_id, record_type, record_group, title, record_id);
    CREATE INDEX records_type_title_idx ON records (workspace_id, record_type, title, record_id);
    CREATE INDEX records_path_idx ON records (workspace_id, path);
    CREATE INDEX records_updated_idx ON records (workspace_id, updated_at, record_id);
    CREATE INDEX edges_from_idx ON edges (workspace_id, from_id, edge_type);
    CREATE INDEX edges_to_idx ON edges (workspace_id, to_id, edge_type);
    CREATE INDEX edges_type_idx ON edges (workspace_id, edge_type, from_id, to_id);
    CREATE INDEX proposals_status_idx ON proposals (workspace_id, status, created_at);
    CREATE INDEX proposals_status_updated_idx ON proposals (workspace_id, status, updated_at, proposal_id);
    CREATE INDEX search_documents_source_idx ON search_documents (workspace_id, source_commit);
  `;
}
