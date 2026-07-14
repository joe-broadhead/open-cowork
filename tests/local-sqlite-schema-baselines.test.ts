import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { setWorkflowDatabaseForTests } from '@open-cowork/runtime-host/workflow/workflow-store'
import { setCoordinationDatabaseForTests } from '@open-cowork/runtime-host/coordination/coordination-store'
import { setArtifactLifecycleDatabaseForTests } from '@open-cowork/runtime-host/artifact-index'
import { setKnowledgeDatabaseForTests } from '@open-cowork/runtime-host/knowledge/knowledge-store'

type StoreAdapter = {
  name: string
  metaTable: string
  initialize: (db: DatabaseSync) => void
  reset: () => void
}

const stores: StoreAdapter[] = [
  {
    name: 'workflow',
    metaTable: 'workflow_meta',
    initialize: (db) => setWorkflowDatabaseForTests(db),
    reset: () => setWorkflowDatabaseForTests(null),
  },
  {
    name: 'coordination',
    metaTable: 'coordination_meta',
    initialize: (db) => setCoordinationDatabaseForTests(db),
    reset: () => setCoordinationDatabaseForTests(null),
  },
  {
    name: 'artifact lifecycle/index',
    metaTable: 'artifact_lifecycle_meta',
    initialize: (db) => setArtifactLifecycleDatabaseForTests(db),
    reset: () => setArtifactLifecycleDatabaseForTests(null),
  },
  {
    name: 'knowledge',
    metaTable: 'knowledge_meta',
    initialize: (db) => setKnowledgeDatabaseForTests(db),
    reset: () => setKnowledgeDatabaseForTests(null),
  },
]

function currentVersion(store: StoreAdapter) {
  const db = new DatabaseSync(':memory:')
  try {
    store.initialize(db)
    const row = db.prepare(`select value from ${store.metaTable} where key = 'schema_version'`)
      .get() as { value?: unknown } | undefined
    return Number(row?.value)
  } finally {
    store.reset()
    db.close()
  }
}

function snapshot(db: DatabaseSync) {
  return {
    schema: db.prepare(`
      select type, name, sql
      from sqlite_schema
      where name not like 'sqlite_%'
      order by type, name
    `).all(),
    sentinel: db.prepare(`
      select name, payload
      from sentinel_payload
      order by name
    `).all(),
  }
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

test('local SQLite stores create only the current clean baseline in an empty database', () => {
  for (const store of stores) {
    const db = new DatabaseSync(':memory:')
    try {
      store.initialize(db)
      const version = db.prepare(`select value from ${store.metaTable} where key = 'schema_version'`)
        .get() as { value?: unknown } | undefined
      assert.match(String(version?.value), /^\d+$/, `${store.name} must record a current version`)
      const tables = db.prepare("select count(*) as count from sqlite_schema where type = 'table' and name not like 'sqlite_%'")
        .get() as { count: number }
      assert.ok(tables.count > 1, `${store.name} must create its baseline tables`)
    } finally {
      store.reset()
      db.close()
    }
  }
})

test('local SQLite stores reject missing, older, future, and shape-drifted schemas without mutation', () => {
  for (const store of stores) {
    const version = currentVersion(store)
    assert.ok(Number.isSafeInteger(version) && version > 0)

    for (const scenario of ['missing', 'older', 'future', 'shape'] as const) {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec(`
          create table sentinel_payload (name text primary key, payload text not null);
          insert into sentinel_payload (name, payload) values ('proof', 'must-survive');
        `)
        if (scenario !== 'missing') {
          db.exec(`create table ${store.metaTable} (key text primary key, value text not null)`)
          const declaredVersion = scenario === 'older'
            ? version - 1
            : scenario === 'future' ? version + 1 : version
          db.prepare(`insert into ${store.metaTable} (key, value) values ('schema_version', ?)`)
            .run(String(declaredVersion))
        }
        const before = snapshot(db)

        assert.throws(
          () => store.initialize(db),
          /does not migrate local durable data in place.*left untouched/,
          `${store.name} should reject ${scenario} schema state`,
        )
        assert.deepEqual(snapshot(db), before, `${store.name} must not mutate ${scenario} schema state`)
      } finally {
        store.reset()
        db.close()
      }
    }
  }
})

test('current local SQLite ledgers do not mask missing indexes or column drift', () => {
  for (const store of stores) {
    for (const scenario of ['missing-index', 'column-drift'] as const) {
      const db = new DatabaseSync(':memory:')
      try {
        store.initialize(db)
        store.reset()
        db.exec(`
          create table sentinel_payload (name text primary key, payload text not null);
          insert into sentinel_payload (name, payload) values ('proof', 'must-survive');
        `)

        if (scenario === 'missing-index') {
          const index = db.prepare(`
            select name
            from sqlite_schema
            where type = 'index' and name not like 'sqlite_%'
            order by name
            limit 1
          `).get() as { name: string }
          db.exec(`drop index ${quoteIdentifier(index.name)}`)
        } else {
          const table = db.prepare(`
            select name
            from sqlite_schema
            where type = 'table'
              and name not like 'sqlite_%'
              and name not in (?, 'sentinel_payload')
            order by name
            limit 1
          `).get(store.metaTable) as { name: string }
          db.exec(`alter table ${quoteIdentifier(table.name)} add column unexpected_preview_column text`)
        }
        const before = snapshot(db)

        assert.throws(
          () => store.initialize(db),
          scenario === 'missing-index' ? /current schema index .* is missing/ : /required current columns/,
          `${store.name} should reject ${scenario}`,
        )
        assert.deepEqual(snapshot(db), before, `${store.name} must not repair ${scenario}`)
      } finally {
        store.reset()
        db.close()
      }
    }
  }
})
