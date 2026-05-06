import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getAppDataDir } from './config-loader.ts'

let automationDb: DatabaseSync | null = null
let automationTransactionCounter = 0

function getAutomationDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'automation.sqlite')
}

function ensureAutomationDbFileModes(dbPath = getAutomationDbPath()) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: string }>
  if (rows.some((row) => row.name === column)) return
  db.exec(`alter table ${table} add column ${column} ${definition}`)
}

export function getDb() {
  if (automationDb) return automationDb
  const dbPath = getAutomationDbPath()
  const db = new DatabaseSync(dbPath)
  db.exec('pragma journal_mode = WAL;')
  db.exec(`
    create table if not exists automations (
      id text primary key,
      title text not null,
      goal text not null,
      kind text not null,
      status text not null,
      paused_from_status text,
      schedule_json text not null,
      heartbeat_minutes integer not null,
      retry_max_attempts integer not null default 3,
      retry_base_delay_minutes integer not null default 5,
      retry_max_delay_minutes integer not null default 60,
      run_daily_run_cap integer not null default 6,
      run_max_duration_minutes integer not null default 120,
      execution_mode text not null,
      autonomy_policy text not null,
      project_directory text,
      preferred_agents_json text not null default '[]',
      created_at text not null,
      updated_at text not null,
      next_run_at text,
      last_run_at text,
      next_heartbeat_at text,
      last_heartbeat_at text,
      latest_run_id text,
      latest_run_status text,
      latest_session_id text
    );

    create table if not exists automation_briefs (
      automation_id text primary key,
      brief_json text not null,
      updated_at text not null
    );

    create table if not exists automation_runs (
      id text primary key,
      automation_id text not null,
      session_id text,
      kind text not null,
      status text not null,
      title text not null,
      summary text,
      error text,
      failure_code text,
      attempt integer not null default 1,
      retry_of_run_id text,
      next_retry_at text,
      created_at text not null,
      started_at text,
      finished_at text
    );

    create table if not exists automation_work_items (
      id text not null,
      automation_id text not null,
      run_id text,
      title text not null,
      description text not null,
      status text not null,
      blocking_reason text,
      owner_agent text,
      depends_on_json text not null,
      created_at text not null,
      updated_at text not null,
      primary key (automation_id, id)
    );

    create table if not exists automation_inbox (
      id text primary key,
      automation_id text not null,
      run_id text,
      session_id text,
      question_id text,
      type text not null,
      status text not null,
      title text not null,
      body text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists automation_deliveries (
      id text primary key,
      automation_id text not null,
      run_id text,
      provider text not null,
      target text not null,
      status text not null,
      title text not null,
      body text not null,
      created_at text not null
    );
  `)
  const workItemsSql = db.prepare("select sql from sqlite_master where type = 'table' and name = 'automation_work_items'").get() as { sql?: string } | undefined
  if (!workItemsSql?.sql?.includes('primary key (automation_id, id)')) {
    db.exec(`
      create table automation_work_items_v2 (
        id text not null,
        automation_id text not null,
        run_id text,
        title text not null,
        description text not null,
        status text not null,
        blocking_reason text,
        owner_agent text,
        depends_on_json text not null,
        created_at text not null,
        updated_at text not null,
        primary key (automation_id, id)
      );
      insert into automation_work_items_v2 (
        id, automation_id, run_id, title, description, status, blocking_reason, owner_agent, depends_on_json, created_at, updated_at
      )
      select id, automation_id, run_id, title, description, status, blocking_reason, owner_agent, depends_on_json, created_at, updated_at
      from automation_work_items;
      drop table automation_work_items;
      alter table automation_work_items_v2 rename to automation_work_items;
    `)
  }
  ensureColumn(db, 'automations', 'paused_from_status', 'text')
  ensureColumn(db, 'automations', 'next_heartbeat_at', 'text')
  ensureColumn(db, 'automations', 'last_heartbeat_at', 'text')
  ensureColumn(db, 'automations', 'retry_max_attempts', 'integer not null default 3')
  ensureColumn(db, 'automations', 'retry_base_delay_minutes', 'integer not null default 5')
  ensureColumn(db, 'automations', 'retry_max_delay_minutes', 'integer not null default 60')
  ensureColumn(db, 'automations', 'run_daily_run_cap', 'integer not null default 6')
  ensureColumn(db, 'automations', 'run_max_duration_minutes', 'integer not null default 120')
  ensureColumn(db, 'automations', 'preferred_agents_json', `text not null default '[]'`)
  ensureColumn(db, 'automation_runs', 'attempt', 'integer not null default 1')
  ensureColumn(db, 'automation_runs', 'retry_of_run_id', 'text')
  ensureColumn(db, 'automation_runs', 'next_retry_at', 'text')
  ensureColumn(db, 'automation_runs', 'failure_code', 'text')
  ensureAutomationDbFileModes(dbPath)
  automationDb = db
  return db
}

export function withTransaction<T>(callback: (db: DatabaseSync) => T): T {
  const db = getDb()
  const savepoint = `automation_tx_${automationTransactionCounter += 1}`
  db.exec(`savepoint ${savepoint}`)
  try {
    const result = callback(db)
    db.exec(`release savepoint ${savepoint}`)
    ensureAutomationDbFileModes()
    return result
  } catch (error) {
    try {
      db.exec(`rollback to savepoint ${savepoint}`)
    } finally {
      db.exec(`release savepoint ${savepoint}`)
      ensureAutomationDbFileModes()
    }
    throw error
  }
}

export function clearAutomationStoreCache() {
  automationDb?.close()
  automationDb = null
}
