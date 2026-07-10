import type { DatabaseSync } from 'node:sqlite'

export const THREAD_INDEX_SCHEMA_VERSION = 2

const THREAD_INDEX_SCHEMA_VERSION_KEY = 'schema_version'

function readThreadIndexSchemaVersion(db: DatabaseSync) {
  const row = db.prepare('select value from thread_index_meta where key = ?')
    .get(THREAD_INDEX_SCHEMA_VERSION_KEY) as { value?: string } | undefined
  const version = Number(row?.value || 0)
  return Number.isInteger(version) && version >= 0 ? version : 0
}

function recordThreadIndexSchemaVersion(db: DatabaseSync) {
  db.prepare(`
    insert into thread_index_meta (key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(THREAD_INDEX_SCHEMA_VERSION_KEY, String(THREAD_INDEX_SCHEMA_VERSION))
}

// `create table if not exists` cannot add a column to a table that already exists, so databases
// created under an earlier thread-index schema need the columns backfilled. This is idempotent
// forward migration for existing on-disk databases (not old-format back-compat): a fresh install
// gets the columns from CREATE TABLE and these ALTERs are no-ops.
function ensureColumn(db: DatabaseSync, tableName: string, columnName: string, definition: string) {
  const rows = db.prepare(`pragma table_info(${tableName})`).all() as Array<{ name?: string }>
  if (rows.some((row) => row.name === columnName)) return
  db.exec(`alter table ${tableName} add column ${columnName} ${definition}`)
}

export function migrateThreadIndexDb(db: DatabaseSync) {
  db.exec(`
    create table if not exists thread_index_meta (
      key text primary key,
      value text not null
    );
  `)
  const version = readThreadIndexSchemaVersion(db)
  if (version > THREAD_INDEX_SCHEMA_VERSION) {
    throw new Error(`Thread index schema version ${version} is newer than supported version ${THREAD_INDEX_SCHEMA_VERSION}.`)
  }
  db.exec(`
    create table if not exists thread_index (
      session_id text primary key,
      title text not null,
      kind text not null,
      directory text,
      project_label text,
      provider_id text,
      model_id text,
      status text not null,
      created_at text not null,
      updated_at text not null,
      parent_session_id text,
      workflow_id text,
      run_id text,
      reverted_message_id text,
      message_count integer not null default 0,
      tool_call_count integer not null default 0,
      task_run_count integer not null default 0,
      cost real not null default 0,
      input_tokens integer not null default 0,
      output_tokens integer not null default 0,
      reasoning_tokens integer not null default 0,
      cache_read_tokens integer not null default 0,
      cache_write_tokens integer not null default 0,
      change_files integer not null default 0,
      change_additions integer not null default 0,
      change_deletions integer not null default 0,
      change_source text,
      indexed_at text not null,
      metadata_version integer not null
    );

    create table if not exists thread_index_agents (
      session_id text not null,
      agent text not null,
      count integer not null,
      primary key(session_id, agent)
    );

    create table if not exists thread_index_tools (
      session_id text not null,
      tool_name text not null,
      mcp_name text,
      count integer not null,
      primary key(session_id, tool_name)
    );

    create table if not exists thread_tags (
      id text primary key,
      name text not null unique,
      color text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists thread_tag_links (
      session_id text not null,
      tag_id text not null,
      created_at text not null,
      primary key(session_id, tag_id)
    );

    create table if not exists thread_smart_filters (
      id text primary key,
      name text not null,
      query_json text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists thread_category_suggestions (
      id text primary key,
      session_id text not null,
      label text not null,
      reason text not null,
      evidence_json text not null,
      status text not null,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists idx_thread_index_updated on thread_index(updated_at desc, session_id);
    create index if not exists idx_thread_index_created on thread_index(created_at desc, session_id);
    create index if not exists idx_thread_index_title on thread_index(lower(title), session_id);
    create index if not exists idx_thread_index_provider on thread_index(provider_id);
    create index if not exists idx_thread_index_model on thread_index(model_id);
    create index if not exists idx_thread_index_status on thread_index(status);
    create index if not exists idx_thread_index_project on thread_index(project_label);
    create index if not exists idx_thread_tag_links_tag on thread_tag_links(tag_id);
    create index if not exists idx_thread_suggestions_session on thread_category_suggestions(session_id, status);
  `)
  ensureColumn(db, 'thread_index', 'workflow_id', 'text')
  ensureColumn(db, 'thread_index', 'change_source', 'text')
  recordThreadIndexSchemaVersion(db)
}
