type QueryRow = Record<string, unknown>

export type PostgresSchemaExecutor = {
  query<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>
}

export type PostgresColumnShape = {
  tableName: string
  columnName: string
  ordinal: number
  dataType: string
  notNull: boolean
  defaultExpression: string | null
}

export type PostgresConstraintShape = {
  tableName: string
  kind: 'p' | 'u' | 'f' | 'c'
  columns: readonly string[]
  referencedSchema: string | null
  referencedTable: string | null
  referencedColumns: readonly string[]
  updateAction: string | null
  deleteAction: string | null
  matchType: string | null
  deferrable: boolean
  initiallyDeferred: boolean
  validated: boolean
  locallyDefined: boolean
  inheritanceCount: number
  noInherit: boolean
  checkExpression: string | null
}

export type PostgresIndexShape = {
  indexName: string
  tableName: string
  accessMethod: string
  unique: boolean
  nullsNotDistinct: boolean
  keyExpressions: readonly string[]
  predicate: string | null
}

export type PostgresFunctionShape = {
  functionSchema: string
  functionName: string
  identityArguments: string
  language: string
  resultType: string
  body: string
  securityDefiner: boolean
  volatility: 'immutable' | 'stable' | 'volatile'
  leakproof: boolean
  strict: boolean
  parallelSafety: 'unsafe' | 'restricted' | 'safe'
  configuration: readonly string[]
}

export type PostgresTriggerShape = {
  triggerName: string
  tableName: string
  functionSchema: string
  functionName: string
  functionIdentityArguments: string
  functionArguments: readonly string[]
  whenExpression: string | null
  oldTransitionTable: string | null
  newTransitionTable: string | null
  typeMask: number
  enabled: string
}

export type PostgresSchemaManifest = {
  tableNames: readonly string[]
  columns: readonly PostgresColumnShape[]
  constraints: readonly PostgresConstraintShape[]
  indexes: readonly PostgresIndexShape[]
  functions: readonly PostgresFunctionShape[]
  triggers: readonly PostgresTriggerShape[]
}

const COLUMN_TYPE_PATTERN = '(text|timestamptz|integer|bigint|jsonb|boolean)'
const CURRENT_SCHEMA = '@current-schema'

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

const SQL_LITERAL_TOKEN_START = '\u0001'
const SQL_LITERAL_TOKEN_END = '\u0002'

function protectSqlLiterals(value: string) {
  const literals: string[] = []
  let syntax = ''
  for (let index = 0; index < value.length;) {
    const char = value[index]!
    if (char === "'") {
      const start = index
      const escapeString = index > 0
        && (value[index - 1] === 'e' || value[index - 1] === 'E')
        && (index < 2 || !/[a-z0-9_]/i.test(value[index - 2]!))
      index += 1
      let terminated = false
      while (index < value.length) {
        if (escapeString && value[index] === '\\') {
          index += Math.min(2, value.length - index)
          continue
        }
        if (value[index] !== "'") {
          index += 1
          continue
        }
        if (value[index + 1] === "'") {
          index += 2
          continue
        }
        index += 1
        terminated = true
        break
      }
      if (!terminated) throw new Error('Unterminated single-quoted SQL literal in schema DDL.')
      const literalIndex = literals.push(value.slice(start, index)) - 1
      syntax += `${SQL_LITERAL_TOKEN_START}${literalIndex}${SQL_LITERAL_TOKEN_END}`
      continue
    }
    if (char === '$') {
      const tag = value.slice(index).match(/^\$[a-zA-Z0-9_]*\$/)?.[0]
      if (tag) {
        const end = value.indexOf(tag, index + tag.length)
        if (end < 0) throw new Error(`Unterminated dollar-quoted SQL literal ${tag} in schema DDL.`)
        const literalEnd = end + tag.length
        const literalIndex = literals.push(value.slice(index, literalEnd)) - 1
        syntax += `${SQL_LITERAL_TOKEN_START}${literalIndex}${SQL_LITERAL_TOKEN_END}`
        index = literalEnd
        continue
      }
    }
    syntax += char
    index += 1
  }
  return { syntax, literals }
}

function restoreSqlLiterals(value: string, literals: readonly string[]) {
  return value.replace(
    new RegExp(`${SQL_LITERAL_TOKEN_START}(\\d+)${SQL_LITERAL_TOKEN_END}`, 'g'),
    (_match, index: string) => literals[Number(index)] || '',
  )
}

function stripBalancedOuterParentheses(value: string) {
  let result = value.trim()
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0
    let wrapsWholeValue = true
    let quoted = false
    for (let index = 0; index < result.length; index += 1) {
      const char = result[index]!
      if (char === "'") {
        if (quoted && result[index + 1] === "'") {
          index += 1
          continue
        }
        quoted = !quoted
      }
      if (quoted) continue
      if (char === '(') depth += 1
      if (char === ')') depth -= 1
      if (depth === 0 && index < result.length - 1) {
        wrapsWholeValue = false
        break
      }
    }
    if (!wrapsWholeValue) break
    result = result.slice(1, -1).trim()
  }
  return result
}

function normalizeExpression(value: string | null | undefined) {
  if (!value) return null
  const protectedSql = protectSqlLiterals(value)
  let result = normalizeWhitespace(protectedSql.syntax)
    .toLowerCase()
    .replaceAll('"', '')
    .replace(/::(?:text|character varying)\b/g, '')
  result = result.replace(
    /\(?([a-z_][a-z0-9_.]*)\s*=\s*any\s*\(array\[(.*?)\]\)\)?/g,
    (_match, column: string, values: string) => `${column} in (${values})`,
  )
  let previous = ''
  while (previous !== result) {
    previous = result
    result = result
      .replace(/\(([a-z_][a-z0-9_.]*\s+is\s+(?:not\s+)?null)\)/g, '$1')
      .replace(/\(([a-z_][a-z0-9_.]*\s+in\s+\([^()]*\))\)/g, '$1')
      // AND binds more tightly than OR in PostgreSQL, so parentheses around an
      // AND-only group are catalog-printing noise rather than logical shape.
      .replace(/\(([^()]*)\)/g, (match, inner: string) => (
        inner.includes(' and ') && !inner.includes(' or ') ? inner : match
      ))
  }
  return restoreSqlLiterals(
    stripBalancedOuterParentheses(normalizeWhitespace(result)),
    protectedSql.literals,
  )
}

function normalizeDefault(value: string | null | undefined) {
  if (!value) return null
  const protectedSql = protectSqlLiterals(value)
  return restoreSqlLiterals(
    stripBalancedOuterParentheses(
      normalizeWhitespace(protectedSql.syntax).toLowerCase().replace(/::text\b/g, ''),
    ),
    protectedSql.literals,
  )
}

function normalizeIndexExpression(value: string) {
  const normalized = normalizeExpression(value)!
  const match = normalized.match(/^(.*?)(?:\s+(asc|desc))?(?:\s+nulls\s+(first|last))?$/)
  if (!match) return normalized
  const direction = match[2] || 'asc'
  const nulls = match[3] || (direction === 'desc' ? 'first' : 'last')
  return `${match[1]!.trim()} ${direction} nulls ${nulls}`
}

function normalizeDataType(value: string) {
  const normalized = normalizeWhitespace(value).toLowerCase()
  return normalized === 'timestamptz' ? 'timestamp with time zone' : normalized
}

function splitTopLevel(value: string, delimiter: ',' | ';') {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let singleQuoted = false
  let doubleQuoted = false
  let dollarTag: string | null = null
  for (let index = 0; index < value.length; index += 1) {
    if (dollarTag) {
      if (value.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1
        dollarTag = null
      }
      continue
    }
    const char = value[index]!
    if (!singleQuoted && !doubleQuoted && char === '$') {
      const tag = value.slice(index).match(/^\$[a-zA-Z0-9_]*\$/)?.[0]
      if (tag) {
        dollarTag = tag
        index += tag.length - 1
        continue
      }
    }
    if (!doubleQuoted && char === "'") {
      if (singleQuoted && value[index + 1] === "'") {
        index += 1
        continue
      }
      singleQuoted = !singleQuoted
      continue
    }
    if (!singleQuoted && char === '"') {
      doubleQuoted = !doubleQuoted
      continue
    }
    if (singleQuoted || doubleQuoted) continue
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === delimiter && depth === 0) {
      const part = value.slice(start, index).trim()
      if (part) parts.push(part)
      start = index + 1
    }
  }
  const tail = value.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

function parenthesizedRange(value: string, openIndex: number) {
  let depth = 0
  let quoted = false
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index]!
    if (char === "'") {
      if (quoted && value[index + 1] === "'") {
        index += 1
        continue
      }
      quoted = !quoted
    }
    if (quoted) continue
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return { start: openIndex + 1, end: index }
    }
  }
  throw new Error(`Unbalanced schema DDL near ${value.slice(0, 80)}`)
}

function identifierList(value: string) {
  return splitTopLevel(value, ',').map((entry) => (
    normalizeWhitespace(entry).replaceAll('"', '').toLowerCase()
  ))
}

function defaultFromColumnRemainder(value: string) {
  const match = value.match(
    /\bDEFAULT\s+('(?:''|[^'])*'(?:\s*::\s*[a-z][a-z0-9_]*)?|[+-]?\d+(?:\.\d+)?|true|false|[a-z_][a-z0-9_]*\(\))/i,
  )
  return normalizeDefault(match?.[1])
}

function checkFromDefinition(value: string) {
  const checkIndex = value.search(/\bCHECK\s*\(/i)
  if (checkIndex < 0) return null
  const openIndex = value.indexOf('(', checkIndex)
  const range = parenthesizedRange(value, openIndex)
  return normalizeExpression(value.slice(range.start, range.end))
}

function constraintBehavior(
  definition: string,
  kind: PostgresConstraintShape['kind'],
) {
  const explicitlyNotDeferrable = /\bNOT\s+DEFERRABLE\b/i.test(definition)
  const deferrable = !explicitlyNotDeferrable && /\bDEFERRABLE\b/i.test(definition)
  return {
    deferrable,
    initiallyDeferred: deferrable && /\bINITIALLY\s+DEFERRED\b/i.test(definition),
    // CREATE TABLE constraints are validated unless an explicitly supported
    // NOT VALID clause says otherwise. Keeping this in the derived manifest
    // makes a drop/re-add of an equivalent but unvalidated constraint visible.
    validated: !/\bNOT\s+VALID\b/i.test(definition),
    locallyDefined: true,
    inheritanceCount: 0,
    noInherit: kind === 'c' && /\bNO\s+INHERIT\b/i.test(definition),
  }
}

function inlineConstraintTiming(
  remainder: string,
  constraint: 'PRIMARY KEY' | 'UNIQUE',
) {
  const keyword = constraint === 'PRIMARY KEY' ? 'PRIMARY\\s+KEY' : 'UNIQUE'
  return remainder.match(
    new RegExp(`\\b${keyword}\\b\\s*((?:(?:NOT\\s+)?DEFERRABLE\\b|INITIALLY\\s+(?:IMMEDIATE|DEFERRED)\\b|\\s)*)`, 'i'),
  )?.[1]?.trim() || ''
}

function referentialAction(value: string, action: 'UPDATE' | 'DELETE') {
  return value.match(
    new RegExp(`\\bON\\s+${action}\\s+(CASCADE|SET\\s+NULL|SET\\s+DEFAULT|RESTRICT|NO\\s+ACTION)\\b`, 'i'),
  )?.[1]?.replace(/\s+/g, ' ').toLowerCase() || 'no action'
}

function foreignKeyFromDefinition(
  tableName: string,
  value: string,
  implicitColumns: readonly string[] = [],
): PostgresConstraintShape | null {
  const normalized = normalizeWhitespace(value)
  const tableLevel = normalized.match(/^FOREIGN KEY\s*\(([^)]+)\)\s+REFERENCES\s+([a-z][a-z0-9_]*)\s*\(([^)]+)\)(.*)$/i)
  const columnLevel = normalized.match(/\bREFERENCES\s+([a-z][a-z0-9_]*)\s*\(([^)]+)\)(.*)$/i)
  const match = tableLevel || columnLevel
  if (!match) return null
  const remainder = tableLevel ? match[4]! : match[3]!
  return {
    tableName,
    kind: 'f',
    columns: tableLevel ? identifierList(match[1]!) : implicitColumns,
    referencedSchema: CURRENT_SCHEMA,
    referencedTable: (tableLevel ? match[2] : match[1])!.toLowerCase(),
    referencedColumns: identifierList((tableLevel ? match[3] : match[2])!),
    updateAction: referentialAction(remainder, 'UPDATE'),
    deleteAction: referentialAction(remainder, 'DELETE'),
    matchType: remainder.match(/\bMATCH\s+(FULL|PARTIAL|SIMPLE)\b/i)?.[1]?.toLowerCase() || 'simple',
    ...constraintBehavior(value, 'f'),
    checkExpression: null,
  }
}

function pushTableConstraint(
  constraints: PostgresConstraintShape[],
  tableName: string,
  rawDefinition: string,
  implicitColumns: readonly string[] = [],
) {
  const definition = normalizeWhitespace(rawDefinition)
    .replace(/^CONSTRAINT\s+[a-z][a-z0-9_]*\s+/i, '')
  const primary = definition.match(/^PRIMARY KEY\s*\(([^)]+)\)/i)
  if (primary) {
    constraints.push({
      tableName,
      kind: 'p',
      columns: identifierList(primary[1]!),
      referencedSchema: null,
      referencedTable: null,
      referencedColumns: [],
      updateAction: null,
      deleteAction: null,
      matchType: null,
      ...constraintBehavior(definition, 'p'),
      checkExpression: null,
    })
  }
  const unique = definition.match(/^UNIQUE\s*\(([^)]+)\)/i)
  if (unique) {
    constraints.push({
      tableName,
      kind: 'u',
      columns: identifierList(unique[1]!),
      referencedSchema: null,
      referencedTable: null,
      referencedColumns: [],
      updateAction: null,
      deleteAction: null,
      matchType: null,
      ...constraintBehavior(definition, 'u'),
      checkExpression: null,
    })
  }
  const foreignKey = foreignKeyFromDefinition(tableName, definition, implicitColumns)
  if (foreignKey) constraints.push(foreignKey)
  const checkExpression = checkFromDefinition(definition)
  if (checkExpression) {
    constraints.push({
      tableName,
      kind: 'c',
      columns: [],
      referencedSchema: null,
      referencedTable: null,
      referencedColumns: [],
      updateAction: null,
      deleteAction: null,
      matchType: null,
      ...constraintBehavior(definition, 'c'),
      checkExpression,
    })
  }
}

function parseTable(
  statement: string,
  columns: PostgresColumnShape[],
  constraints: PostgresConstraintShape[],
) {
  const prefix = statement.match(/^CREATE TABLE IF NOT EXISTS\s+([a-z][a-z0-9_]*)\s*\(/i)
  if (!prefix) return null
  const tableName = prefix[1]!.toLowerCase()
  const openIndex = statement.indexOf('(', prefix[0].length - 1)
  const range = parenthesizedRange(statement, openIndex)
  let ordinal = 0
  for (const rawDefinition of splitTopLevel(statement.slice(range.start, range.end), ',')) {
    const definition = normalizeWhitespace(rawDefinition)
    if (/^(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY KEY|UNIQUE\s*\(|FOREIGN KEY|CHECK\s*\()/i.test(definition)) {
      pushTableConstraint(constraints, tableName, definition)
      continue
    }
    const column = definition.match(new RegExp(`^([a-z][a-z0-9_]*)\\s+${COLUMN_TYPE_PATTERN}\\b(.*)$`, 'i'))
    if (!column) throw new Error(`Unsupported column DDL in ${tableName}: ${definition}`)
    ordinal += 1
    const columnName = column[1]!.toLowerCase()
    const remainder = column[3] || ''
    columns.push({
      tableName,
      columnName,
      ordinal,
      dataType: normalizeDataType(column[2]!),
      notNull: /\bNOT NULL\b|\bPRIMARY KEY\b/i.test(remainder),
      defaultExpression: defaultFromColumnRemainder(remainder),
    })
    if (/\bPRIMARY KEY\b/i.test(remainder)) {
      pushTableConstraint(
        constraints,
        tableName,
        `PRIMARY KEY (${columnName}) ${inlineConstraintTiming(remainder, 'PRIMARY KEY')}`,
      )
    }
    if (/\bUNIQUE\b/i.test(remainder)) {
      pushTableConstraint(
        constraints,
        tableName,
        `UNIQUE (${columnName}) ${inlineConstraintTiming(remainder, 'UNIQUE')}`,
      )
    }
    pushTableConstraint(constraints, tableName, remainder, [columnName])
  }
  return tableName
}

function parseIndex(statement: string): PostgresIndexShape | null {
  const prefix = statement.match(
    /^CREATE\s+(UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?\s+IF NOT EXISTS\s+([a-z][a-z0-9_]*)\s+ON\s+([a-z][a-z0-9_]*)(?:\s+USING\s+([a-z][a-z0-9_]*))?\s*/i,
  )
  if (!prefix) return null
  const openIndex = statement.indexOf('(', prefix[0].length)
  const range = parenthesizedRange(statement, openIndex)
  const remainder = normalizeWhitespace(statement.slice(range.end + 1))
  const predicate = remainder.match(/(?:^|\s)WHERE\s+(.+)$/i)?.[1] || null
  return {
    indexName: prefix[2]!.toLowerCase(),
    tableName: prefix[3]!.toLowerCase(),
    accessMethod: prefix[4]?.toLowerCase() || 'btree',
    unique: Boolean(prefix[1]),
    nullsNotDistinct: /\bNULLS\s+NOT\s+DISTINCT\b/i.test(remainder),
    keyExpressions: splitTopLevel(statement.slice(range.start, range.end), ',')
      .map(normalizeIndexExpression),
    predicate: normalizeExpression(predicate),
  }
}

const FUNCTION_OPTION_BOUNDARY = /\s+(?=(?:LANGUAGE|TRANSFORM|WINDOW|IMMUTABLE|STABLE|VOLATILE|LEAKPROOF|NOT\s+LEAKPROOF|CALLED\s+ON\s+NULL\s+INPUT|RETURNS\s+NULL\s+ON\s+NULL\s+INPUT|STRICT|SECURITY\s+INVOKER|SECURITY\s+DEFINER|PARALLEL\s+(?:UNSAFE|RESTRICTED|SAFE)|COST|ROWS|SUPPORT|SET|AS)\b)/i

function normalizeFunctionConfiguration(value: string) {
  const separator = value.indexOf('=')
  if (separator < 1) throw new Error(`Invalid PostgreSQL function configuration: ${value}`)
  const name = value.slice(0, separator).trim().toLowerCase()
  const rawValue = value.slice(separator + 1).trim()
  const normalizedValue = splitTopLevel(rawValue, ',').map((entry) => {
    const atom = entry.trim()
    if (/^'(?:''|[^'])*'$/.test(atom)) return atom.slice(1, -1).replaceAll("''", "'")
    return normalizeWhitespace(atom)
  }).join(', ')
  return `${name}=${normalizedValue}`
}

function parseFunctionConfiguration(options: string) {
  const protectedSql = protectSqlLiterals(options)
  const configuration: string[] = []
  const setPattern = /\bSET\s+([a-z][a-z0-9_.]*)\s*(TO\s+|=\s*)(?!FROM\s+CURRENT\b)/ig
  let match: RegExpExecArray | null
  while ((match = setPattern.exec(protectedSql.syntax))) {
    const valueStart = match.index + match[0].length
    const remainder = protectedSql.syntax.slice(valueStart)
    const boundary = remainder.search(FUNCTION_OPTION_BOUNDARY)
    const valueEnd = boundary < 0 ? protectedSql.syntax.length : valueStart + boundary
    const rawValue = restoreSqlLiterals(
      protectedSql.syntax.slice(valueStart, valueEnd).trim(),
      protectedSql.literals,
    )
    if (!rawValue) throw new Error(`Function SET ${match[1]} is missing its value.`)
    configuration.push(normalizeFunctionConfiguration(`${match[1]}=${rawValue}`))
    setPattern.lastIndex = valueEnd
  }
  if (/\bSET\s+[a-z][a-z0-9_.]*\s+FROM\s+CURRENT\b/i.test(protectedSql.syntax)) {
    throw new Error('Function SET ... FROM CURRENT is non-deterministic and is not supported in the clean baseline.')
  }
  return configuration.sort()
}

function parseFunction(statement: string): PostgresFunctionShape | null {
  const prefix = statement.match(
    /^CREATE OR REPLACE FUNCTION\s+([a-z][a-z0-9_]*)\s*\(\)\s+RETURNS\s+([a-z][a-z0-9_]*)\b/i,
  )
  if (!prefix) return null
  const bodyDeclaration = statement.slice(prefix[0].length).match(/\bAS\s+(\$[a-zA-Z0-9_]*\$)/i)
  if (!bodyDeclaration || bodyDeclaration.index === undefined) {
    throw new Error(`Function ${prefix[1]} must use a deterministic dollar-quoted body.`)
  }
  const delimiter = bodyDeclaration[1]!
  const bodyStart = prefix[0].length + bodyDeclaration.index + bodyDeclaration[0].lastIndexOf(delimiter)
  const contentStart = bodyStart + delimiter.length
  const bodyEnd = statement.indexOf(delimiter, contentStart)
  if (bodyEnd < 0) throw new Error(`Function ${prefix[1]} has an unterminated body.`)
  const options = `${statement.slice(prefix[0].length, bodyStart)} ${statement.slice(bodyEnd + delimiter.length)}`
  const language = options.match(/\bLANGUAGE\s+([a-z][a-z0-9_]*)/i)?.[1]
  if (!language) throw new Error(`Function ${prefix[1]} is missing its language declaration.`)
  const volatility: PostgresFunctionShape['volatility'] = /\bIMMUTABLE\b/i.test(options)
    ? 'immutable'
    : /\bSTABLE\b/i.test(options)
      ? 'stable'
      : 'volatile'
  const parallelSafety: PostgresFunctionShape['parallelSafety'] = /\bPARALLEL\s+SAFE\b/i.test(options)
    ? 'safe'
    : /\bPARALLEL\s+RESTRICTED\b/i.test(options)
      ? 'restricted'
      : 'unsafe'
  return {
    functionSchema: CURRENT_SCHEMA,
    functionName: prefix[1]!.toLowerCase(),
    identityArguments: '',
    language: language.toLowerCase(),
    resultType: prefix[2]!.toLowerCase(),
    body: normalizeWhitespace(statement.slice(contentStart, bodyEnd)),
    securityDefiner: /\bSECURITY\s+DEFINER\b/i.test(options),
    volatility,
    leakproof: !/\bNOT\s+LEAKPROOF\b/i.test(options) && /\bLEAKPROOF\b/i.test(options),
    strict: /\bSTRICT\b|\bRETURNS\s+NULL\s+ON\s+NULL\s+INPUT\b/i.test(options),
    parallelSafety,
    configuration: parseFunctionConfiguration(options),
  }
}

function parseTrigger(statement: string): PostgresTriggerShape | null {
  const normalized = normalizeWhitespace(statement)
  const match = normalized.match(
    /^CREATE OR REPLACE TRIGGER\s+([a-z][a-z0-9_]*)\s+(BEFORE|AFTER|INSTEAD OF)\s+(.+?)\s+ON\s+([a-z][a-z0-9_]*)\s+(.+)$/i,
  )
  if (!match) return null
  const remainder = match[5]!
  const execute = remainder.match(
    /\bEXECUTE FUNCTION\s+((?:[a-z][a-z0-9_]*\.)?[a-z][a-z0-9_]*)\s*\(/i,
  )
  if (!execute || execute.index === undefined) {
    throw new Error(`Trigger ${match[1]} must execute one deterministic trigger function.`)
  }
  const argumentOpen = remainder.indexOf('(', execute.index + execute[0].length - 1)
  const argumentRange = parenthesizedRange(remainder, argumentOpen)
  if (remainder.slice(argumentRange.end + 1).trim()) {
    throw new Error(`Unsupported clauses after trigger function ${execute[1]}.`)
  }
  const functionArguments = splitTopLevel(
    remainder.slice(argumentRange.start, argumentRange.end),
    ',',
  ).map((argument) => {
    const value = argument.trim()
    if (/^'(?:''|[^'])*'$/.test(value)) {
      return value.slice(1, -1).replaceAll("''", "'")
    }
    if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) return value
    throw new Error(`Unsupported trigger argument ${value} in ${match[1]}.`)
  })

  let clauses = remainder.slice(0, execute.index).trim()
  let whenExpression: string | null = null
  const when = clauses.match(/\bWHEN\s*\(/i)
  if (when?.index !== undefined) {
    const whenOpen = clauses.indexOf('(', when.index)
    const whenRange = parenthesizedRange(clauses, whenOpen)
    if (clauses.slice(whenRange.end + 1).trim()) {
      throw new Error(`Trigger ${match[1]} has unsupported clauses after WHEN.`)
    }
    whenExpression = normalizeExpression(clauses.slice(whenRange.start, whenRange.end))
    clauses = clauses.slice(0, when.index).trim()
  }

  const each = clauses.match(/\bFOR\s+(?:EACH\s+)?(ROW|STATEMENT)\s*$/i)
  if (!each || each.index === undefined) {
    throw new Error(`Trigger ${match[1]} must declare FOR EACH ROW or STATEMENT.`)
  }
  const rowLevel = each[1]!.toLowerCase() === 'row'
  clauses = clauses.slice(0, each.index).trim()

  let oldTransitionTable: string | null = null
  let newTransitionTable: string | null = null
  if (clauses) {
    let references = clauses.replace(/^REFERENCING\s+/i, '')
    if (references === clauses) {
      throw new Error(`Unsupported trigger clauses in ${match[1]}: ${clauses}`)
    }
    while (references) {
      const reference = references.match(
        /^(OLD|NEW)\s+TABLE(?:\s+AS)?\s+([a-z][a-z0-9_]*)(?:\s+|$)/i,
      )
      if (!reference) throw new Error(`Unsupported trigger transition relation in ${match[1]}: ${references}`)
      const transitionName = reference[2]!.toLowerCase()
      if (reference[1]!.toLowerCase() === 'old') {
        if (oldTransitionTable) throw new Error(`Trigger ${match[1]} declares OLD TABLE more than once.`)
        oldTransitionTable = transitionName
      } else {
        if (newTransitionTable) throw new Error(`Trigger ${match[1]} declares NEW TABLE more than once.`)
        newTransitionTable = transitionName
      }
      references = references.slice(reference[0].length).trim()
    }
  }

  const functionIdentifier = execute[1]!.toLowerCase().split('.')
  const functionName = functionIdentifier.at(-1)!
  const functionSchema = functionIdentifier.length === 2 ? functionIdentifier[0]! : CURRENT_SCHEMA
  let typeMask = rowLevel ? 1 : 0
  const timing = match[2]!.toLowerCase()
  if (timing === 'before') typeMask += 2
  if (timing === 'instead of') typeMask += 64
  const events = match[3]!.split(/\s+OR\s+/i).map((value) => value.toLowerCase())
  if (events.includes('insert')) typeMask += 4
  if (events.includes('delete')) typeMask += 8
  if (events.includes('update')) typeMask += 16
  if (events.includes('truncate')) typeMask += 32
  return {
    triggerName: match[1]!.toLowerCase(),
    tableName: match[4]!.toLowerCase(),
    functionSchema,
    functionName,
    functionIdentityArguments: '',
    functionArguments,
    whenExpression,
    oldTransitionTable,
    newTransitionTable,
    typeMask,
    enabled: 'O',
  }
}

function sorted<T>(values: readonly T[]) {
  return [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

/**
 * Derives the expected catalog from the one authoritative clean baseline. The
 * parser deliberately accepts only the narrow DDL vocabulary used by Open
 * Cowork; adding an unsupported construct fails during startup/tests instead
 * of silently weakening physical integrity validation.
 */
export function createPostgresSchemaManifest(sql: readonly string[]): PostgresSchemaManifest {
  const columns: PostgresColumnShape[] = []
  const constraints: PostgresConstraintShape[] = []
  const indexes: PostgresIndexShape[] = []
  const functions: PostgresFunctionShape[] = []
  const triggers: PostgresTriggerShape[] = []
  const tableNames = new Set<string>()
  for (const statement of sql.flatMap((value) => splitTopLevel(value, ';'))) {
    const tableName = parseTable(statement, columns, constraints)
    if (tableName) {
      tableNames.add(tableName)
      continue
    }
    const index = parseIndex(statement)
    if (index) {
      indexes.push(index)
      continue
    }
    const fn = parseFunction(statement)
    if (fn) {
      functions.push(fn)
      continue
    }
    const trigger = parseTrigger(statement)
    if (trigger) {
      triggers.push(trigger)
      continue
    }
    if (/^CREATE\b/i.test(statement)) {
      throw new Error(`Unsupported clean-baseline DDL: ${statement.slice(0, 100)}`)
    }
  }
  return Object.freeze({
    tableNames: Object.freeze([...tableNames].sort()),
    columns: Object.freeze(sorted(columns)),
    constraints: Object.freeze(sorted(constraints)),
    indexes: Object.freeze(sorted(indexes)),
    functions: Object.freeze(sorted(functions)),
    triggers: Object.freeze(sorted(triggers)),
  })
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string') return []
  if (value === '{}') return []
  if (value.startsWith('{') && value.endsWith('}')) {
    return value.slice(1, -1).split(',').filter(Boolean)
  }
  return [value]
}

function decodeTriggerArgumentsHex(value: unknown) {
  const hex = String(value || '')
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) {
    throw new Error('PostgreSQL returned malformed trigger arguments.')
  }
  if (!hex) return []
  const bytes = Uint8Array.from(
    hex.match(/[0-9a-f]{2}/gi) || [],
    (pair) => Number.parseInt(pair, 16),
  )
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const argumentsWithTerminator = decoded.split('\0')
  if (argumentsWithTerminator.at(-1) !== '') {
    throw new Error('PostgreSQL returned unterminated trigger arguments.')
  }
  argumentsWithTerminator.pop()
  return argumentsWithTerminator
}

function functionIdentityKey(schema: string, name: string, identityArguments: string) {
  return `${schema}\0${name}\0${normalizeWhitespace(identityArguments)}`
}

function triggerWhenExpression(triggerDefinition: unknown) {
  const definition = String(triggerDefinition || '')
  const when = definition.match(/\bWHEN\s*\(/i)
  if (when?.index === undefined) return null
  const openIndex = definition.indexOf('(', when.index)
  const range = parenthesizedRange(definition, openIndex)
  return normalizeExpression(definition.slice(range.start, range.end))
}

function describeDifference<T>(expected: readonly T[], actual: readonly T[]) {
  const expectedStrings = new Set(expected.map((value) => JSON.stringify(value)))
  const actualStrings = new Set(actual.map((value) => JSON.stringify(value)))
  const missing = [...expectedStrings].filter((value) => !actualStrings.has(value))
  const unexpected = [...actualStrings].filter((value) => !expectedStrings.has(value))
  const parts: string[] = []
  if (missing.length > 0) parts.push(`missing ${missing.slice(0, 3).join(', ')}`)
  if (unexpected.length > 0) parts.push(`unexpected ${unexpected.slice(0, 3).join(', ')}`)
  return parts.join('; ')
}

function assertShapes<T>(label: string, expected: readonly T[], actual: readonly T[]) {
  const expectedSorted = sorted(expected)
  const actualSorted = sorted(actual)
  if (JSON.stringify(expectedSorted) === JSON.stringify(actualSorted)) return
  throw new Error(`${label} do not match the clean baseline (${describeDifference(expectedSorted, actualSorted)}).`)
}

/**
 * Read-only catalog validation for an already-initialized schema. Callers pass
 * the product-scoped table inventory so unrelated tables in a shared schema do
 * not create false positives, while legacy product-prefixed tables still fail.
 */
export async function assertPostgresSchemaManifest(
  executor: PostgresSchemaExecutor,
  manifest: PostgresSchemaManifest,
  actualProductTableNames: ReadonlySet<string>,
) {
  assertShapes('product tables', manifest.tableNames, [...actualProductTableNames])
  const columns = await executor.query<{
    table_name: string
    column_name: string
    ordinal: number | string
    data_type: string
    not_null: boolean
    default_expression: string | null
  }>(
    `SELECT table_class.relname AS table_name,
            attribute.attname AS column_name,
            attribute.attnum AS ordinal,
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
            attribute.attnotnull AS not_null,
            pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid, true) AS default_expression
     FROM pg_catalog.pg_class table_class
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
     JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = table_class.oid
     LEFT JOIN pg_catalog.pg_attrdef attribute_default
       ON attribute_default.adrelid = table_class.oid
      AND attribute_default.adnum = attribute.attnum
     WHERE namespace.nspname = current_schema()
       AND table_class.relkind IN ('r', 'p')
       AND table_class.relname = ANY($1::text[])
       AND attribute.attnum > 0
       AND attribute.attisdropped = false
     ORDER BY table_class.relname, attribute.attnum`,
    [manifest.tableNames],
  )
  const actualColumns = columns.rows.map((row): PostgresColumnShape => ({
    tableName: String(row.table_name),
    columnName: String(row.column_name),
    ordinal: Number(row.ordinal),
    dataType: normalizeDataType(String(row.data_type)),
    notNull: row.not_null === true,
    defaultExpression: normalizeDefault(row.default_expression),
  }))
  assertShapes('table columns', manifest.columns, actualColumns)

  const constraints = await executor.query<{
    table_name: string
    kind: PostgresConstraintShape['kind']
    columns: unknown
    referenced_schema: string | null
    referenced_is_current_schema: boolean | null
    referenced_table: string | null
    referenced_columns: unknown
    update_action: string | null
    delete_action: string | null
    match_type: string | null
    is_deferrable: boolean
    is_initially_deferred: boolean
    is_validated: boolean
    is_local: boolean
    inheritance_count: number | string
    no_inherit: boolean
    check_expression: string | null
  }>(
    `SELECT table_class.relname AS table_name,
            constraint_row.contype AS kind,
            COALESCE((
              SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
              FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
              JOIN pg_catalog.pg_attribute attribute
                ON attribute.attrelid = constraint_row.conrelid
               AND attribute.attnum = key_column.attnum
            ), ARRAY[]::text[]) AS columns,
            referenced_namespace.nspname AS referenced_schema,
            referenced_namespace.nspname = current_schema() AS referenced_is_current_schema,
            referenced_class.relname AS referenced_table,
            COALESCE((
              SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
              FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key_column(attnum, ordinality)
              JOIN pg_catalog.pg_attribute attribute
                ON attribute.attrelid = constraint_row.confrelid
               AND attribute.attnum = key_column.attnum
            ), ARRAY[]::text[]) AS referenced_columns,
            CASE WHEN constraint_row.contype = 'f' THEN
              CASE constraint_row.confupdtype
                WHEN 'c' THEN 'cascade'
                WHEN 'n' THEN 'set null'
                WHEN 'd' THEN 'set default'
                WHEN 'r' THEN 'restrict'
                ELSE 'no action'
              END
            END AS update_action,
            CASE WHEN constraint_row.contype = 'f' THEN
              CASE constraint_row.confdeltype
                WHEN 'c' THEN 'cascade'
                WHEN 'n' THEN 'set null'
                WHEN 'd' THEN 'set default'
                WHEN 'r' THEN 'restrict'
                ELSE 'no action'
              END
            END AS delete_action,
            CASE WHEN constraint_row.contype = 'f' THEN
              CASE constraint_row.confmatchtype
                WHEN 'f' THEN 'full'
                WHEN 'p' THEN 'partial'
                ELSE 'simple'
              END
            END AS match_type,
            constraint_row.condeferrable AS is_deferrable,
            constraint_row.condeferred AS is_initially_deferred,
            constraint_row.convalidated AS is_validated,
            constraint_row.conislocal AS is_local,
            constraint_row.coninhcount AS inheritance_count,
            constraint_row.connoinherit AS no_inherit,
            CASE WHEN constraint_row.contype = 'c'
              THEN pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid, true)
              ELSE NULL
            END AS check_expression
     FROM pg_catalog.pg_constraint constraint_row
     JOIN pg_catalog.pg_class table_class ON table_class.oid = constraint_row.conrelid
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
     LEFT JOIN pg_catalog.pg_class referenced_class ON referenced_class.oid = constraint_row.confrelid
     LEFT JOIN pg_catalog.pg_namespace referenced_namespace ON referenced_namespace.oid = referenced_class.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_class.relname = ANY($1::text[])
       AND constraint_row.contype IN ('p', 'u', 'f', 'c')
     ORDER BY table_class.relname, constraint_row.contype, constraint_row.oid`,
    [manifest.tableNames],
  )
  const actualConstraints = constraints.rows.map((row): PostgresConstraintShape => ({
    tableName: String(row.table_name),
    kind: row.kind,
    columns: row.kind === 'c' ? [] : stringArray(row.columns),
    referencedSchema: row.referenced_schema
      ? (row.referenced_is_current_schema === true ? CURRENT_SCHEMA : String(row.referenced_schema))
      : null,
    referencedTable: row.referenced_table ? String(row.referenced_table) : null,
    referencedColumns: stringArray(row.referenced_columns),
    updateAction: row.kind === 'f' ? String(row.update_action) : null,
    deleteAction: row.kind === 'f' ? String(row.delete_action) : null,
    matchType: row.kind === 'f' ? String(row.match_type) : null,
    deferrable: row.is_deferrable === true,
    initiallyDeferred: row.is_initially_deferred === true,
    validated: row.is_validated === true,
    locallyDefined: row.is_local === true,
    inheritanceCount: Number(row.inheritance_count),
    noInherit: row.kind === 'c' && row.no_inherit === true,
    checkExpression: row.kind === 'c' ? normalizeExpression(row.check_expression) : null,
  }))
  assertShapes('table constraints', manifest.constraints, actualConstraints)

  const indexes = await executor.query<{
    index_name: string
    table_name: string
    access_method: string
    is_unique: boolean
    nulls_not_distinct: boolean
    is_valid: boolean
    key_expressions: unknown
    predicate: string | null
  }>(
    `SELECT index_class.relname AS index_name,
            table_class.relname AS table_name,
            access_method.amname AS access_method,
            index_row.indisunique AS is_unique,
            index_row.indnullsnotdistinct AS nulls_not_distinct,
            index_row.indisvalid AS is_valid,
            ARRAY(
              SELECT pg_catalog.pg_get_indexdef(index_row.indexrelid, key_position, true)
                || COALESCE((
                  SELECT CASE WHEN operator_class.opcdefault
                    THEN ''
                    ELSE ' ' || operator_class.opcname
                  END
                  FROM pg_catalog.pg_opclass operator_class
                  WHERE operator_class.oid = index_row.indclass[key_position - 1]
                ), '')
                || CASE WHEN (index_row.indoption[key_position - 1] & 1) = 1 THEN ' DESC' ELSE ' ASC' END
                || CASE WHEN (index_row.indoption[key_position - 1] & 2) = 2 THEN ' NULLS FIRST' ELSE ' NULLS LAST' END
              FROM generate_series(1, index_row.indnkeyatts) AS key_position
              ORDER BY key_position
            ) AS key_expressions,
            pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, true) AS predicate
     FROM pg_catalog.pg_index index_row
     JOIN pg_catalog.pg_class index_class ON index_class.oid = index_row.indexrelid
     JOIN pg_catalog.pg_am access_method ON access_method.oid = index_class.relam
     JOIN pg_catalog.pg_class table_class ON table_class.oid = index_row.indrelid
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
     LEFT JOIN pg_catalog.pg_constraint constraint_row ON constraint_row.conindid = index_row.indexrelid
     WHERE namespace.nspname = current_schema()
       AND table_class.relname = ANY($1::text[])
       AND constraint_row.oid IS NULL
     ORDER BY index_class.relname`,
    [manifest.tableNames],
  )
  const invalidIndexes = indexes.rows
    .filter((row) => row.is_valid !== true)
    .map((row) => String(row.index_name))
  if (invalidIndexes.length > 0) {
    throw new Error(`indexes are invalid (${invalidIndexes.join(', ')}).`)
  }
  const actualIndexes = indexes.rows.map((row): PostgresIndexShape => ({
    indexName: String(row.index_name),
    tableName: String(row.table_name),
    accessMethod: String(row.access_method),
    unique: row.is_unique === true,
    nullsNotDistinct: row.nulls_not_distinct === true,
    keyExpressions: stringArray(row.key_expressions).map(normalizeIndexExpression),
    predicate: normalizeExpression(row.predicate),
  }))
  assertShapes('explicit indexes', manifest.indexes, actualIndexes)

  const verifiedFunctionOids = new Map<string, string>()
  if (manifest.functions.length > 0) {
    const functions = await executor.query<{
      function_oid: number | string
      function_schema: string
      function_name: string
      identity_arguments: string
      language: string
      result_type: string
      body: string
      security_definer: boolean
      volatility: string
      leakproof: boolean
      is_strict: boolean
      parallel_safety: string
      configuration: unknown
    }>(
      `SELECT procedure.oid AS function_oid,
              namespace.nspname AS function_schema,
              procedure.proname AS function_name,
              pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS identity_arguments,
              language.lanname AS language,
              pg_catalog.pg_get_function_result(procedure.oid) AS result_type,
              procedure.prosrc AS body,
              procedure.prosecdef AS security_definer,
              procedure.provolatile AS volatility,
              procedure.proleakproof AS leakproof,
              procedure.proisstrict AS is_strict,
              procedure.proparallel AS parallel_safety,
              procedure.proconfig AS configuration
       FROM pg_catalog.pg_proc procedure
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
       JOIN pg_catalog.pg_language language ON language.oid = procedure.prolang
       WHERE namespace.nspname = current_schema()
         AND procedure.proname = ANY($1::text[])
         AND procedure.prokind = 'f'
       ORDER BY procedure.proname, identity_arguments`,
      [manifest.functions.map((entry) => entry.functionName)],
    )
    const actualFunctionCatalog = functions.rows.map((row) => ({
      oid: String(row.function_oid),
      shape: {
        functionSchema: CURRENT_SCHEMA,
        functionName: String(row.function_name),
        identityArguments: normalizeWhitespace(String(row.identity_arguments)),
        language: String(row.language),
        resultType: String(row.result_type),
        body: normalizeWhitespace(String(row.body)),
        securityDefiner: row.security_definer === true,
        volatility: row.volatility === 'i' ? 'immutable' : row.volatility === 's' ? 'stable' : 'volatile',
        leakproof: row.leakproof === true,
        strict: row.is_strict === true,
        parallelSafety: row.parallel_safety === 's' ? 'safe' : row.parallel_safety === 'r' ? 'restricted' : 'unsafe',
        configuration: stringArray(row.configuration).map(normalizeFunctionConfiguration).sort(),
      } satisfies PostgresFunctionShape,
    }))
    const actualFunctions = actualFunctionCatalog.map((entry) => entry.shape)
    assertShapes('schema functions', manifest.functions, actualFunctions)

    for (const entry of actualFunctionCatalog) {
      verifiedFunctionOids.set(functionIdentityKey(
        entry.shape.functionSchema,
        entry.shape.functionName,
        entry.shape.identityArguments,
      ), entry.oid)
    }
  }

  const triggers = await executor.query<{
      trigger_name: string
      table_name: string
      function_oid: number | string
      function_schema: string
      function_is_current_schema: boolean
      function_name: string
      function_identity_arguments: string
      function_arguments_hex: string
      trigger_definition: string
      old_transition_table: string | null
      new_transition_table: string | null
      type_mask: number | string
      enabled: string
  }>(
      `SELECT trigger_row.tgname AS trigger_name,
              table_class.relname AS table_name,
              procedure.oid AS function_oid,
              procedure_namespace.nspname AS function_schema,
              procedure_namespace.nspname = current_schema() AS function_is_current_schema,
              procedure.proname AS function_name,
              pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS function_identity_arguments,
              pg_catalog.encode(trigger_row.tgargs, 'hex') AS function_arguments_hex,
              pg_catalog.pg_get_triggerdef(trigger_row.oid, true) AS trigger_definition,
              trigger_row.tgoldtable AS old_transition_table,
              trigger_row.tgnewtable AS new_transition_table,
              trigger_row.tgtype AS type_mask,
              trigger_row.tgenabled AS enabled
       FROM pg_catalog.pg_trigger trigger_row
       JOIN pg_catalog.pg_class table_class ON table_class.oid = trigger_row.tgrelid
       JOIN pg_catalog.pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
       JOIN pg_catalog.pg_proc procedure ON procedure.oid = trigger_row.tgfoid
       JOIN pg_catalog.pg_namespace procedure_namespace ON procedure_namespace.oid = procedure.pronamespace
       WHERE table_namespace.nspname = current_schema()
         AND table_class.relname = ANY($1::text[])
         AND trigger_row.tgisinternal = false
       ORDER BY trigger_row.tgname`,
      [manifest.tableNames],
    )
  const actualTriggers = triggers.rows.map((row): PostgresTriggerShape => {
      const functionSchema = row.function_is_current_schema === true
        ? CURRENT_SCHEMA
        : String(row.function_schema)
      const functionName = String(row.function_name)
      const functionIdentityArguments = normalizeWhitespace(String(row.function_identity_arguments))
      const verifiedFunctionOid = verifiedFunctionOids.get(functionIdentityKey(
        functionSchema,
        functionName,
        functionIdentityArguments,
      ))
      if (!verifiedFunctionOid || verifiedFunctionOid !== String(row.function_oid)) {
        throw new Error(
          `table trigger ${String(row.trigger_name)} is not bound to the exact verified function schema, OID, and signature.`,
        )
      }
      return {
        triggerName: String(row.trigger_name),
        tableName: String(row.table_name),
        functionSchema,
        functionName,
        functionIdentityArguments,
        functionArguments: decodeTriggerArgumentsHex(row.function_arguments_hex),
        whenExpression: triggerWhenExpression(row.trigger_definition),
        oldTransitionTable: row.old_transition_table ? String(row.old_transition_table) : null,
        newTransitionTable: row.new_transition_table ? String(row.new_transition_table) : null,
        typeMask: Number(row.type_mask),
        enabled: String(row.enabled),
      }
  })
  assertShapes('table triggers', manifest.triggers, actualTriggers)
}
