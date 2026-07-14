import type { DatabaseSync } from 'node:sqlite'
import { initializeLocalSqliteSchema } from '../local-sqlite-schema.js'

export const THREAD_INDEX_SCHEMA_VERSION = 1

const THREAD_INDEX_SCHEMA_VERSION_KEY = 'schema_version'

const THREAD_INDEX_BASELINE_SQL = `
  create table thread_index_meta (
    key text primary key,
    value text not null
  );
  create table thread_index (
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

  create table thread_index_agents (
    session_id text not null,
    agent text not null,
    count integer not null,
    primary key(session_id, agent)
  );

  create table thread_index_tools (
    session_id text not null,
    tool_name text not null,
    mcp_name text,
    count integer not null,
    primary key(session_id, tool_name)
  );

  create table thread_tags (
    id text primary key,
    name text not null unique,
    color text not null,
    created_at text not null,
    updated_at text not null
  );

  create table thread_tag_links (
    session_id text not null,
    tag_id text not null,
    created_at text not null,
    primary key(session_id, tag_id)
  );

  create table thread_smart_filters (
    id text primary key,
    name text not null,
    query_json text not null,
    created_at text not null,
    updated_at text not null
  );

  create table thread_category_suggestions (
    id text primary key,
    session_id text not null,
    label text not null,
    reason text not null,
    evidence_json text not null,
    status text not null,
    created_at text not null,
    updated_at text not null
  );

  create index idx_thread_index_updated on thread_index(updated_at desc, session_id);
  create index idx_thread_index_created on thread_index(created_at desc, session_id);
  create index idx_thread_index_title on thread_index(lower(title), session_id);
  create index idx_thread_index_provider on thread_index(provider_id);
  create index idx_thread_index_model on thread_index(model_id);
  create index idx_thread_index_status on thread_index(status);
  create index idx_thread_index_project on thread_index(project_label);
  create index idx_thread_tag_links_tag on thread_tag_links(tag_id);
  create index idx_thread_suggestions_session on thread_category_suggestions(session_id, status);
`

export function initializeThreadIndexDb(db: DatabaseSync) {
  initializeLocalSqliteSchema(db, {
    storeName: 'local thread index',
    currentVersion: THREAD_INDEX_SCHEMA_VERSION,
    metaTable: 'thread_index_meta',
    versionKey: THREAD_INDEX_SCHEMA_VERSION_KEY,
    baselineSql: THREAD_INDEX_BASELINE_SQL,
    tables: [
      { name: 'thread_index_meta', columns: ['key', 'value'] },
      { name: 'thread_index', columns: ['session_id', 'title', 'kind', 'directory', 'project_label', 'provider_id', 'model_id', 'status', 'created_at', 'updated_at', 'parent_session_id', 'workflow_id', 'run_id', 'reverted_message_id', 'message_count', 'tool_call_count', 'task_run_count', 'cost', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'change_files', 'change_additions', 'change_deletions', 'change_source', 'indexed_at', 'metadata_version'] },
      { name: 'thread_index_agents', columns: ['session_id', 'agent', 'count'] },
      { name: 'thread_index_tools', columns: ['session_id', 'tool_name', 'mcp_name', 'count'] },
      { name: 'thread_tags', columns: ['id', 'name', 'color', 'created_at', 'updated_at'] },
      { name: 'thread_tag_links', columns: ['session_id', 'tag_id', 'created_at'] },
      { name: 'thread_smart_filters', columns: ['id', 'name', 'query_json', 'created_at', 'updated_at'] },
      { name: 'thread_category_suggestions', columns: ['id', 'session_id', 'label', 'reason', 'evidence_json', 'status', 'created_at', 'updated_at'] },
    ],
    indexes: [
      'idx_thread_index_updated',
      'idx_thread_index_created',
      'idx_thread_index_title',
      'idx_thread_index_provider',
      'idx_thread_index_model',
      'idx_thread_index_status',
      'idx_thread_index_project',
      'idx_thread_tag_links_tag',
      'idx_thread_suggestions_session',
    ],
    recovery: 'Back up the thread-index database (including user tags, filters, and suggestions), then reset or import only that index; do not delete OpenCode sessions or project files.',
  })
}
