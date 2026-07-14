import type { DatabaseSync } from 'node:sqlite'

type LocalSqliteTableShape = {
  name: string
  columns: readonly string[]
}

export type LocalSqliteSchemaDefinition = {
  storeName: string
  currentVersion: number
  metaTable: string
  versionKey: string
  baselineSql: string
  tables: readonly LocalSqliteTableShape[]
  indexes: readonly string[]
  recovery: string
}

type SqliteSchemaObject = {
  type?: unknown
  name?: unknown
}

class LocalSqliteSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalSqliteSchemaError'
  }
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

function currentSchemaObjects(db: DatabaseSync) {
  return db.prepare(`
    select type, name
    from sqlite_schema
    where name not like 'sqlite_%'
    order by type, name
  `).all() as SqliteSchemaObject[]
}

function schemaError(
  definition: LocalSqliteSchemaDefinition,
  problem: string,
) {
  return new LocalSqliteSchemaError(
    `Open Cowork cannot open the ${definition.storeName}: ${problem} `
    + `This pre-release build does not migrate local durable data in place. ${definition.recovery} `
    + 'The existing database was left untouched.',
  )
}

function readDeclaredVersion(
  db: DatabaseSync,
  definition: LocalSqliteSchemaDefinition,
  objects: readonly SqliteSchemaObject[],
) {
  const hasMetaTable = objects.some((entry) => (
    entry.type === 'table' && entry.name === definition.metaTable
  ))
  if (!hasMetaTable) {
    throw schemaError(
      definition,
      `the required ${definition.metaTable} schema ledger is missing; expected version ${definition.currentVersion}.`,
    )
  }

  let row: { value?: unknown } | undefined
  try {
    row = db.prepare(`select value from ${quoteIdentifier(definition.metaTable)} where key = ?`)
      .get(definition.versionKey) as { value?: unknown } | undefined
  } catch {
    throw schemaError(
      definition,
      `the ${definition.metaTable} schema ledger is not readable in the current shape.`,
    )
  }

  const rawVersion = typeof row?.value === 'string' ? row.value : ''
  const version = /^\d+$/.test(rawVersion) ? Number(rawVersion) : Number.NaN
  if (!Number.isSafeInteger(version) || version !== definition.currentVersion) {
    const found = rawVersion ? `version ${rawVersion}` : 'no valid version'
    throw schemaError(
      definition,
      `the database declares ${found}; this build requires exact schema version ${definition.currentVersion}.`,
    )
  }
}

function assertCurrentShape(
  db: DatabaseSync,
  definition: LocalSqliteSchemaDefinition,
  objects: readonly SqliteSchemaObject[],
) {
  const tableNames = new Set(
    objects
      .filter((entry) => entry.type === 'table' && typeof entry.name === 'string')
      .map((entry) => entry.name as string),
  )
  const indexNames = new Set(
    objects
      .filter((entry) => entry.type === 'index' && typeof entry.name === 'string')
      .map((entry) => entry.name as string),
  )

  for (const table of definition.tables) {
    if (!tableNames.has(table.name)) {
      throw schemaError(definition, `the current schema table ${table.name} is missing.`)
    }
    const rows = db.prepare(`pragma table_info(${quoteIdentifier(table.name)})`).all() as Array<{ name?: unknown }>
    const columns = rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string')
    if (
      columns.length !== table.columns.length
      || columns.some((column, index) => column !== table.columns[index])
    ) {
      throw schemaError(
        definition,
        `table ${table.name} does not match the required current columns.`,
      )
    }
  }

  for (const index of definition.indexes) {
    if (!indexNames.has(index)) {
      throw schemaError(definition, `the current schema index ${index} is missing.`)
    }
  }
}

function createBaseline(db: DatabaseSync, definition: LocalSqliteSchemaDefinition) {
  db.exec('begin immediate')
  try {
    db.exec(definition.baselineSql)
    db.prepare(`insert into ${quoteIdentifier(definition.metaTable)} (key, value) values (?, ?)`)
      .run(definition.versionKey, String(definition.currentVersion))
    assertCurrentShape(db, definition, currentSchemaObjects(db))
    db.exec('commit')
  } catch (error) {
    try {
      db.exec('rollback')
    } catch {
      // Preserve the baseline-creation error. A failed transaction is never
      // accepted as current, and the caller closes the connection.
    }
    throw error
  }
}

/**
 * Creates one clean baseline only for an empty database. Existing databases
 * are read-only during initialization: the exact current ledger and physical
 * shape must already be present, otherwise startup fails with reset/export
 * guidance instead of silently repairing or re-versioning durable data.
 */
export function initializeLocalSqliteSchema(
  db: DatabaseSync,
  definition: LocalSqliteSchemaDefinition,
) {
  let objects: SqliteSchemaObject[]
  try {
    objects = currentSchemaObjects(db)
  } catch {
    throw schemaError(definition, 'the SQLite schema catalog is not readable.')
  }
  if (objects.length === 0) {
    createBaseline(db, definition)
    return
  }

  try {
    readDeclaredVersion(db, definition, objects)
    assertCurrentShape(db, definition, objects)
  } catch (error) {
    if (error instanceof LocalSqliteSchemaError) throw error
    throw schemaError(definition, 'the declared current schema could not be validated.')
  }
}
