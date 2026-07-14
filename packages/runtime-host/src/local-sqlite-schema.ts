import { DatabaseSync } from 'node:sqlite'

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
  tableName?: unknown
  sql?: unknown
}

type CanonicalSqliteSchemaObject = {
  type: string
  name: string
  tableName: string
  sql: string
}

const canonicalSchemaCache = new Map<string, readonly CanonicalSqliteSchemaObject[]>()

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
    select type, name, tbl_name as tableName, sql
    from sqlite_schema
    where name not like 'sqlite_%'
    order by type, name
  `).all() as SqliteSchemaObject[]
}

function normalizeSchemaSql(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function canonicalObject(entry: SqliteSchemaObject): CanonicalSqliteSchemaObject | null {
  if (
    typeof entry.type !== 'string'
    || typeof entry.name !== 'string'
    || typeof entry.tableName !== 'string'
  ) return null
  return {
    type: entry.type,
    name: entry.name,
    tableName: entry.tableName,
    sql: normalizeSchemaSql(entry.sql),
  }
}

function canonicalBaselineObjects(definition: LocalSqliteSchemaDefinition) {
  const cacheKey = JSON.stringify([
    definition.storeName,
    definition.baselineSql,
    definition.tables.map((entry) => entry.name),
    definition.indexes,
  ])
  const cached = canonicalSchemaCache.get(cacheKey)
  if (cached) return cached
  const baseline = new DatabaseSync(':memory:')
  try {
    baseline.exec(definition.baselineSql)
    const objects = currentSchemaObjects(baseline)
      .map(canonicalObject)
      .filter((entry): entry is CanonicalSqliteSchemaObject => Boolean(entry))
    const expectedTables = [...definition.tables].map((entry) => entry.name).sort()
    const actualTables = objects
      .filter((entry) => entry.type === 'table')
      .map((entry) => entry.name)
      .sort()
    const expectedIndexes = [...definition.indexes].sort()
    const actualIndexes = objects
      .filter((entry) => entry.type === 'index')
      .map((entry) => entry.name)
      .sort()
    if (
      JSON.stringify(expectedTables) !== JSON.stringify(actualTables)
      || JSON.stringify(expectedIndexes) !== JSON.stringify(actualIndexes)
    ) {
      throw new Error(
        `The ${definition.storeName} baseline manifest is inconsistent with its DDL.`,
      )
    }
    const frozen = Object.freeze(objects.map((entry) => Object.freeze(entry)))
    canonicalSchemaCache.set(cacheKey, frozen)
    return frozen
  } finally {
    baseline.close()
  }
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
  definition: LocalSqliteSchemaDefinition,
  objects: readonly SqliteSchemaObject[],
) {
  // Build the expected catalog in an isolated in-memory database. This keeps
  // validation read-only for the durable database while making the baseline
  // DDL itself the sole source of truth for column order/type/nullability,
  // defaults, PK/FK/CHECK constraints, and exact index expressions/predicates.
  const expected = canonicalBaselineObjects(definition)
  const actual = objects
    .map(canonicalObject)
    .filter((entry): entry is CanonicalSqliteSchemaObject => Boolean(entry))
  const expectedByIdentity = new Map(expected.map((entry) => [`${entry.type}:${entry.name}`, entry]))
  const actualByIdentity = new Map(actual.map((entry) => [`${entry.type}:${entry.name}`, entry]))

  const unexpected = actual.filter((entry) => !expectedByIdentity.has(`${entry.type}:${entry.name}`))
  if (unexpected.length > 0) {
    throw schemaError(
      definition,
      `the database contains unexpected schema objects (${unexpected.slice(0, 8).map((entry) => `${entry.type} ${entry.name}`).join(', ')}).`,
    )
  }
  const missing = expected.filter((entry) => !actualByIdentity.has(`${entry.type}:${entry.name}`))
  if (missing.length > 0) {
    throw schemaError(
      definition,
      `the current schema objects are missing (${missing.slice(0, 8).map((entry) => `${entry.type} ${entry.name}`).join(', ')}).`,
    )
  }
  for (const expectedObject of expected) {
    const actualObject = actualByIdentity.get(`${expectedObject.type}:${expectedObject.name}`)
    if (
      !actualObject
      || actualObject.tableName !== expectedObject.tableName
      || actualObject.sql !== expectedObject.sql
    ) {
      throw schemaError(
        definition,
        `${expectedObject.type} ${expectedObject.name} does not match its canonical current definition.`,
      )
    }
  }
}

function createBaseline(db: DatabaseSync, definition: LocalSqliteSchemaDefinition) {
  db.exec('begin immediate')
  try {
    db.exec(definition.baselineSql)
    db.prepare(`insert into ${quoteIdentifier(definition.metaTable)} (key, value) values (?, ?)`)
      .run(definition.versionKey, String(definition.currentVersion))
    assertCurrentShape(definition, currentSchemaObjects(db))
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
    assertCurrentShape(definition, objects)
  } catch (error) {
    if (error instanceof LocalSqliteSchemaError) throw error
    throw schemaError(definition, 'the declared current schema could not be validated.')
  }
}
