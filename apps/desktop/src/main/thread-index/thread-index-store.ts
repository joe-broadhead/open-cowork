import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ThreadCategorySuggestion,
  ThreadFacetBucket,
  ThreadFacetSummary,
  ThreadIndexUpsertInput,
  ThreadListItem,
  ThreadMetadataCount,
  ThreadSearchQuery,
  ThreadSearchResult,
  ThreadSmartFilter,
  ThreadSmartFilterInput,
  ThreadSuggestionInput,
  ThreadTag,
  ThreadTagInput,
  ThreadToolCount,
} from '@open-cowork/shared'
import {
  THREAD_BULK_MAX_SESSION_IDS,
  THREAD_FILTER_MAX_VALUES,
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SUGGESTION_LABEL_MAX_LENGTH,
} from '@open-cowork/shared'
import { getAppDataDir } from '../config-loader.ts'
import { migrateThreadIndexDb, THREAD_INDEX_SCHEMA_VERSION } from './thread-index-schema.ts'

import {
  THREAD_DEFAULT_TAG_COLOR,
  THREAD_INDEX_METADATA_VERSION,
  asNullableString,
  asNumber,
  asString,
  clampInteger,
  decodeCursor,
  encodeCursor,
  json,
  likePattern,
  makePlaceholders,
  normalizeIdList,
  normalizeSmartFilterInput,
  normalizeStoredThreadStatus,
  normalizeSuggestionInput,
  normalizeTagInput,
  normalizeText,
  normalizeThreadSearchQuery,
  parseJson,
  sortSql,
} from './thread-index-normalizers.ts'

export { THREAD_INDEX_SCHEMA_VERSION }
export { normalizeThreadSearchQuery } from './thread-index-normalizers.ts'

const THREAD_QUERY_CACHE_MAX_ENTRIES = 128
type Row = Record<string, unknown>
type WhereClause = { sql: string; args: SQLInputValue[] }

let threadIndexStore: ThreadIndexStore | null = null

function getThreadIndexDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'thread-index.sqlite')
}

function ensureThreadIndexDbFileModes(dbPath: string) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function nowIso() {
  return new Date().toISOString()
}

function projectLabelForDirectory(directory?: string | null, explicit?: string | null) {
  if (explicit) return explicit
  if (!directory) return null
  const parts = directory.split(/[\\/]+/).filter(Boolean)
  return parts.slice(-2).join('/') || directory
}

function usageTokensFromRow(row: Row) {
  return {
    input: asNumber(row.input_tokens),
    output: asNumber(row.output_tokens),
    reasoning: asNumber(row.reasoning_tokens),
    cacheRead: asNumber(row.cache_read_tokens),
    cacheWrite: asNumber(row.cache_write_tokens),
  }
}

function changeSummaryFromRow(row: Row) {
  const files = asNumber(row.change_files)
  const additions = asNumber(row.change_additions)
  const deletions = asNumber(row.change_deletions)
  return files > 0 || additions > 0 || deletions > 0 ? { files, additions, deletions } : null
}

export class ThreadIndexStore {
  private db: DatabaseSync
  private transactionCounter = 0
  private readonly dbPath: string
  private queryCacheGeneration = 0
  private readonly searchCache = new Map<string, ThreadSearchResult>()
  private readonly facetCache = new Map<string, ThreadFacetSummary>()

  constructor(dbPath = getThreadIndexDbPath()) {
    this.dbPath = dbPath
    mkdirSync(join(dbPath, '..'), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    try {
      this.db.exec('pragma journal_mode = WAL;')
      migrateThreadIndexDb(this.db)
      ensureThreadIndexDbFileModes(this.dbPath)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close() {
    this.db.close()
  }

  private withTransaction<T>(callback: () => T): T {
    const savepoint = `thread_index_tx_${this.transactionCounter += 1}`
    this.db.exec(`savepoint ${savepoint}`)
    try {
      const result = callback()
      this.db.exec(`release savepoint ${savepoint}`)
      ensureThreadIndexDbFileModes(this.dbPath)
      this.invalidateQueryCache()
      return result
    } catch (error) {
      try {
        this.db.exec(`rollback to savepoint ${savepoint}`)
      } finally {
        this.db.exec(`release savepoint ${savepoint}`)
        ensureThreadIndexDbFileModes(this.dbPath)
      }
      throw error
    }
  }

  private invalidateQueryCache() {
    this.queryCacheGeneration += 1
    this.searchCache.clear()
    this.facetCache.clear()
  }

  private rememberCachedQuery<T>(cache: Map<string, T>, key: string, value: T) {
    cache.set(key, value)
    while (cache.size > THREAD_QUERY_CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value
      if (typeof oldestKey !== 'string') break
      cache.delete(oldestKey)
    }
    return value
  }

  private queryCacheKey(kind: 'search' | 'facets', query: ThreadSearchQuery) {
    return JSON.stringify({
      generation: this.queryCacheGeneration,
      kind,
      query,
    })
  }

  upsertThread(input: ThreadIndexUpsertInput) {
    const title = normalizeText(input.title || 'New session', 512, 'Thread title')
    const sessionId = normalizeText(input.sessionId, 256, 'Session id')
    const directory = input.directory || null
    const projectLabel = projectLabelForDirectory(directory, input.projectLabel || null)
    const status = input.status || (
      input.kind === 'workflow_draft' || input.kind === 'workflow_run' || input.workflowId
        ? 'workflow'
        : input.revertedMessageId ? 'reverted' : 'idle'
    )
    const indexedAt = input.indexedAt || nowIso()
    this.withTransaction(() => {
      this.db.prepare(`
        insert into thread_index (
          session_id, title, kind, directory, project_label, provider_id, model_id, status,
          created_at, updated_at, parent_session_id, workflow_id, run_id, reverted_message_id,
          message_count, tool_call_count, task_run_count, cost,
          input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
          change_files, change_additions, change_deletions, indexed_at, metadata_version
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(session_id) do update set
          title = excluded.title,
          kind = excluded.kind,
          directory = excluded.directory,
          project_label = excluded.project_label,
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          parent_session_id = excluded.parent_session_id,
          workflow_id = excluded.workflow_id,
          run_id = excluded.run_id,
          reverted_message_id = excluded.reverted_message_id,
          message_count = excluded.message_count,
          tool_call_count = excluded.tool_call_count,
          task_run_count = excluded.task_run_count,
          cost = excluded.cost,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_tokens = excluded.reasoning_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          change_files = excluded.change_files,
          change_additions = excluded.change_additions,
          change_deletions = excluded.change_deletions,
          indexed_at = excluded.indexed_at,
          metadata_version = excluded.metadata_version
      `).run(
        sessionId,
        title,
        input.kind || 'interactive',
        directory,
        projectLabel,
        input.providerId || null,
        input.modelId || null,
        status,
        input.createdAt,
        input.updatedAt,
        input.parentSessionId || null,
        input.workflowId || null,
        input.runId || null,
        input.revertedMessageId || null,
        input.messageCount || 0,
        input.toolCallCount || 0,
        input.taskRunCount || 0,
        input.cost || 0,
        input.inputTokens || 0,
        input.outputTokens || 0,
        input.reasoningTokens || 0,
        input.cacheReadTokens || 0,
        input.cacheWriteTokens || 0,
        input.changeFiles || 0,
        input.changeAdditions || 0,
        input.changeDeletions || 0,
        indexedAt,
        input.metadataVersion || THREAD_INDEX_METADATA_VERSION,
      )
      if (input.actualAgents) this.replaceAgents(sessionId, input.actualAgents)
      if (input.actualTools) this.replaceTools(sessionId, input.actualTools)
    })
  }

  deleteThread(sessionId: string) {
    const id = normalizeText(sessionId, 256, 'Session id')
    this.withTransaction(() => {
      this.db.prepare('delete from thread_index where session_id = ?').run(id)
      this.db.prepare('delete from thread_index_agents where session_id = ?').run(id)
      this.db.prepare('delete from thread_index_tools where session_id = ?').run(id)
      this.db.prepare('delete from thread_tag_links where session_id = ?').run(id)
      this.db.prepare('delete from thread_category_suggestions where session_id = ?').run(id)
    })
  }

  deleteThreadsNotIn(sessionIds: string[]) {
    if (sessionIds.length === 0) {
      this.withTransaction(() => {
        this.db.exec(`
          delete from thread_index;
          delete from thread_index_agents;
          delete from thread_index_tools;
          delete from thread_tag_links;
          delete from thread_category_suggestions;
        `)
      })
      return
    }
    const ids = normalizeIdList(sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS * 20) || []
    const placeholders = makePlaceholders(ids)
    this.withTransaction(() => {
      this.db.prepare(`delete from thread_index where session_id not in (${placeholders})`).run(...ids)
      this.db.prepare(`delete from thread_index_agents where session_id not in (${placeholders})`).run(...ids)
      this.db.prepare(`delete from thread_index_tools where session_id not in (${placeholders})`).run(...ids)
      this.db.prepare(`delete from thread_tag_links where session_id not in (${placeholders})`).run(...ids)
      this.db.prepare(`delete from thread_category_suggestions where session_id not in (${placeholders})`).run(...ids)
    })
  }

  private replaceAgents(sessionId: string, agents: ThreadMetadataCount[]) {
    this.db.prepare('delete from thread_index_agents where session_id = ?').run(sessionId)
    const insert = this.db.prepare('insert into thread_index_agents (session_id, agent, count) values (?, ?, ?)')
    for (const agent of agents.slice(0, THREAD_FILTER_MAX_VALUES)) {
      const name = normalizeText(agent.name, 128, 'Agent name')
      insert.run(sessionId, name, clampInteger(agent.count, 1, 1, 1_000_000))
    }
  }

  private replaceTools(sessionId: string, tools: ThreadToolCount[]) {
    this.db.prepare('delete from thread_index_tools where session_id = ?').run(sessionId)
    const insert = this.db.prepare('insert into thread_index_tools (session_id, tool_name, mcp_name, count) values (?, ?, ?, ?)')
    for (const tool of tools.slice(0, THREAD_FILTER_MAX_VALUES)) {
      const name = normalizeText(tool.name, 160, 'Tool name')
      insert.run(sessionId, name, tool.mcpName || null, clampInteger(tool.count, 1, 1, 1_000_000))
    }
  }

  private mergeSmartFilter(query: ThreadSearchQuery) {
    if (!query.smartFilterId) return query
    const filter = this.getSmartFilter(query.smartFilterId)
    if (!filter) return { ...query, smartFilterId: null }
    return normalizeThreadSearchQuery({
      ...filter.query,
      text: query.text || filter.query.text,
      cursor: query.cursor || null,
      limit: query.limit || filter.query.limit,
      dateRange: query.dateRange || filter.query.dateRange,
      projectLabels: query.projectLabels?.length ? query.projectLabels : filter.query.projectLabels,
      directories: query.directories?.length ? query.directories : filter.query.directories,
      providerIds: query.providerIds?.length ? query.providerIds : filter.query.providerIds,
      modelIds: query.modelIds?.length ? query.modelIds : filter.query.modelIds,
      agents: query.agents?.length ? query.agents : filter.query.agents,
      tools: query.tools?.length ? query.tools : filter.query.tools,
      mcps: query.mcps?.length ? query.mcps : filter.query.mcps,
      statuses: query.statuses?.length ? query.statuses : filter.query.statuses,
      tagIds: query.tagIds?.length ? query.tagIds : filter.query.tagIds,
      sort: query.sort || filter.query.sort,
      smartFilterId: null,
    })
  }

  private buildWhere(input: ThreadSearchQuery): WhereClause {
    const query = this.mergeSmartFilter(normalizeThreadSearchQuery(input))
    const clauses: string[] = []
    const args: SQLInputValue[] = []

    if (query.text) {
      const pattern = likePattern(query.text)
      clauses.push(`(
        lower(title) like ? escape '\\'
        or lower(coalesce(project_label, '')) like ? escape '\\'
        or lower(coalesce(provider_id, '')) like ? escape '\\'
        or lower(coalesce(model_id, '')) like ? escape '\\'
        or exists (select 1 from thread_tags tag join thread_tag_links link on link.tag_id = tag.id where link.session_id = thread_index.session_id and lower(tag.name) like ? escape '\\')
        or exists (select 1 from thread_index_agents agent where agent.session_id = thread_index.session_id and lower(agent.agent) like ? escape '\\')
        or exists (select 1 from thread_index_tools tool where tool.session_id = thread_index.session_id and (lower(tool.tool_name) like ? escape '\\' or lower(coalesce(tool.mcp_name, '')) like ? escape '\\'))
        or exists (select 1 from thread_category_suggestions suggestion where suggestion.session_id = thread_index.session_id and suggestion.status != 'dismissed' and lower(suggestion.label) like ? escape '\\')
      )`)
      args.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern)
    }
    if (query.dateRange?.from) {
      clauses.push('updated_at >= ?')
      args.push(query.dateRange.from)
    }
    if (query.dateRange?.to) {
      clauses.push('updated_at <= ?')
      args.push(query.dateRange.to)
    }
    const addInClause = (field: string, values?: string[]) => {
      if (!values?.length) return
      clauses.push(`${field} in (${makePlaceholders(values)})`)
      args.push(...values)
    }
    addInClause('project_label', query.projectLabels)
    addInClause('directory', query.directories)
    addInClause('provider_id', query.providerIds)
    addInClause('model_id', query.modelIds)
    addInClause('status', query.statuses)
    if (query.agents?.length) {
      clauses.push(`exists (select 1 from thread_index_agents agent where agent.session_id = thread_index.session_id and agent.agent in (${makePlaceholders(query.agents)}))`)
      args.push(...query.agents)
    }
    if (query.tools?.length) {
      clauses.push(`exists (select 1 from thread_index_tools tool where tool.session_id = thread_index.session_id and tool.tool_name in (${makePlaceholders(query.tools)}))`)
      args.push(...query.tools)
    }
    if (query.mcps?.length) {
      clauses.push(`exists (select 1 from thread_index_tools tool where tool.session_id = thread_index.session_id and tool.mcp_name in (${makePlaceholders(query.mcps)}))`)
      args.push(...query.mcps)
    }
    if (query.tagIds?.length) {
      clauses.push(`exists (select 1 from thread_tag_links link where link.session_id = thread_index.session_id and link.tag_id in (${makePlaceholders(query.tagIds)}))`)
      args.push(...query.tagIds)
    }
    return { sql: clauses.length ? `where ${clauses.join(' and ')}` : '', args }
  }

  searchThreads(input: ThreadSearchQuery = {}): ThreadSearchResult {
    const query = this.mergeSmartFilter(normalizeThreadSearchQuery(input))
    const cacheKey = this.queryCacheKey('search', query)
    const cached = this.searchCache.get(cacheKey)
    if (cached) return cached
    const limit = query.limit || THREAD_SEARCH_DEFAULT_LIMIT
    const offset = decodeCursor(query.cursor)
    const where = this.buildWhere(query)
    const total = this.db.prepare(`select count(*) as count from thread_index ${where.sql}`).get(...where.args) as { count?: number } | undefined
    const rows = this.db.prepare(`
      select *
      from thread_index
      ${where.sql}
      order by ${sortSql(query.sort)}
      limit ? offset ?
    `).all(...where.args, limit, offset) as Row[]
    const threads = this.hydrateRows(rows)
    const totalEstimate = Number(total?.count || 0)
    const nextOffset = offset + rows.length
    return this.rememberCachedQuery(this.searchCache, cacheKey, {
      threads,
      nextCursor: nextOffset < totalEstimate ? encodeCursor(nextOffset) : null,
      totalEstimate,
    })
  }

  getThread(sessionId: string): ThreadListItem | null {
    const id = normalizeText(sessionId, 256, 'Session id')
    const row = this.db.prepare('select * from thread_index where session_id = ?').get(id) as Row | undefined
    if (!row) return null
    return this.hydrateRows([row])[0] || null
  }

  listFacets(input: ThreadSearchQuery = {}): ThreadFacetSummary {
    const query = this.mergeSmartFilter(normalizeThreadSearchQuery({ ...input, cursor: null }))
    const cacheKey = this.queryCacheKey('facets', query)
    const cached = this.facetCache.get(cacheKey)
    if (cached) return cached
    const where = this.buildWhere(query)
    const bucket = (sql: string, args: SQLInputValue[] = where.args): ThreadFacetBucket[] => (
      this.db.prepare(sql).all(...args) as Row[]
    ).map((row) => ({
      value: asString(row.value),
      label: asString(row.label, asString(row.value)),
      count: asNumber(row.count),
    }))
    const baseWhere = where.sql
    const whereAnd = (extra: string) => baseWhere ? `${baseWhere} and ${extra}` : `where ${extra}`
    return this.rememberCachedQuery(this.facetCache, cacheKey, {
      projects: bucket(`select project_label as value, project_label as label, count(*) as count from thread_index ${whereAnd('project_label is not null')} group by project_label order by count desc, project_label asc`),
      providers: bucket(`select provider_id as value, provider_id as label, count(*) as count from thread_index ${whereAnd('provider_id is not null')} group by provider_id order by count desc, provider_id asc`),
      models: bucket(`select model_id as value, model_id as label, count(*) as count from thread_index ${whereAnd('model_id is not null')} group by model_id order by count desc, model_id asc`),
      statuses: bucket(`select status as value, status as label, count(*) as count from thread_index ${baseWhere} group by status order by count desc, status asc`),
      agents: bucket(`select agent.agent as value, agent.agent as label, sum(agent.count) as count from thread_index join thread_index_agents agent on agent.session_id = thread_index.session_id ${baseWhere} group by agent.agent order by count desc, agent.agent asc`),
      tools: bucket(`select tool.tool_name as value, tool.tool_name as label, sum(tool.count) as count from thread_index join thread_index_tools tool on tool.session_id = thread_index.session_id ${baseWhere} group by tool.tool_name order by count desc, tool.tool_name asc`),
      mcps: bucket(`select tool.mcp_name as value, tool.mcp_name as label, sum(tool.count) as count from thread_index join thread_index_tools tool on tool.session_id = thread_index.session_id ${whereAnd('tool.mcp_name is not null')} group by tool.mcp_name order by count desc, tool.mcp_name asc`),
      tags: (this.db.prepare(`
        select tag.id as value, tag.name as label, tag.color as color, count(*) as count
        from thread_index
        join thread_tag_links link on link.session_id = thread_index.session_id
        join thread_tags tag on tag.id = link.tag_id
        ${baseWhere}
        group by tag.id, tag.name, tag.color
        order by count desc, tag.name asc
      `).all(...where.args) as Row[]).map((row) => ({
        value: asString(row.value),
        label: asString(row.label),
        color: asString(row.color),
        count: asNumber(row.count),
      })),
    })
  }

  private hydrateRows(rows: Row[]): ThreadListItem[] {
    if (rows.length === 0) return []
    const ids = rows.map((row) => asString(row.session_id))
    const placeholders = makePlaceholders(ids)
    const tags = this.groupTags(this.db.prepare(`
      select link.session_id, tag.*
      from thread_tag_links link
      join thread_tags tag on tag.id = link.tag_id
      where link.session_id in (${placeholders})
      order by tag.name asc
    `).all(...ids) as Row[])
    const agents = this.groupAgents(this.db.prepare(`
      select * from thread_index_agents where session_id in (${placeholders}) order by count desc, agent asc
    `).all(...ids) as Row[])
    const tools = this.groupTools(this.db.prepare(`
      select * from thread_index_tools where session_id in (${placeholders}) order by count desc, tool_name asc
    `).all(...ids) as Row[])
    const suggestions = this.groupSuggestions(this.db.prepare(`
      select * from thread_category_suggestions
      where session_id in (${placeholders}) and status != 'dismissed'
      order by status asc, label asc
    `).all(...ids) as Row[])
    return rows.map((row) => ({
      sessionId: asString(row.session_id),
      title: asString(row.title, 'New session'),
      directory: asNullableString(row.directory),
      projectLabel: asNullableString(row.project_label),
      providerId: asNullableString(row.provider_id),
      modelId: asNullableString(row.model_id),
      status: normalizeStoredThreadStatus(row.status),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      parentSessionId: asNullableString(row.parent_session_id),
      workflowId: asNullableString(row.workflow_id),
      runId: asNullableString(row.run_id),
      revertedMessageId: asNullableString(row.reverted_message_id),
      tags: tags.get(asString(row.session_id)) || [],
      actualAgents: agents.get(asString(row.session_id)) || [],
      actualTools: tools.get(asString(row.session_id)) || [],
      suggestions: suggestions.get(asString(row.session_id)) || [],
      usage: {
        messages: asNumber(row.message_count),
        toolCalls: asNumber(row.tool_call_count),
        taskRuns: asNumber(row.task_run_count),
        cost: asNumber(row.cost),
        tokens: usageTokensFromRow(row),
      },
      changeSummary: changeSummaryFromRow(row),
    }))
  }

  private groupTags(rows: Row[]) {
    const map = new Map<string, ThreadTag[]>()
    for (const row of rows) {
      const sessionId = asString(row.session_id)
      const next: ThreadTag = {
        id: asString(row.id),
        name: asString(row.name),
        color: asString(row.color, THREAD_DEFAULT_TAG_COLOR),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      }
      map.set(sessionId, [...(map.get(sessionId) || []), next])
    }
    return map
  }

  private groupAgents(rows: Row[]) {
    const map = new Map<string, ThreadMetadataCount[]>()
    for (const row of rows) {
      const sessionId = asString(row.session_id)
      map.set(sessionId, [...(map.get(sessionId) || []), { name: asString(row.agent), count: asNumber(row.count) }])
    }
    return map
  }

  private groupTools(rows: Row[]) {
    const map = new Map<string, ThreadToolCount[]>()
    for (const row of rows) {
      const sessionId = asString(row.session_id)
      map.set(sessionId, [...(map.get(sessionId) || []), {
        name: asString(row.tool_name),
        mcpName: asNullableString(row.mcp_name),
        count: asNumber(row.count),
      }])
    }
    return map
  }

  private groupSuggestions(rows: Row[]) {
    const map = new Map<string, ThreadCategorySuggestion[]>()
    for (const row of rows) {
      const sessionId = asString(row.session_id)
      map.set(sessionId, [...(map.get(sessionId) || []), this.rowToSuggestion(row)])
    }
    return map
  }

  private rowToSuggestion(row: Row): ThreadCategorySuggestion {
    return {
      id: asString(row.id),
      sessionId: asString(row.session_id),
      label: asString(row.label),
      reason: asString(row.reason),
      evidence: parseJson<ThreadCategorySuggestion['evidence']>(row.evidence_json, []),
      status: asString(row.status, 'suggested') as ThreadCategorySuggestion['status'],
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }
  }

  listTags(): ThreadTag[] {
    return (this.db.prepare('select * from thread_tags order by lower(name) asc').all() as Row[]).map((row) => ({
      id: asString(row.id),
      name: asString(row.name),
      color: asString(row.color, THREAD_DEFAULT_TAG_COLOR),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }))
  }

  createTag(input: ThreadTagInput): ThreadTag {
    const tag = normalizeTagInput(input)
    const id = crypto.randomUUID()
    const timestamp = nowIso()
    this.db.prepare(`
      insert into thread_tags (id, name, color, created_at, updated_at)
      values (?, ?, ?, ?, ?)
    `).run(id, tag.name, tag.color, timestamp, timestamp)
    ensureThreadIndexDbFileModes(this.dbPath)
    this.invalidateQueryCache()
    return this.getTag(id)!
  }

  updateTag(tagId: string, input: ThreadTagInput): ThreadTag | null {
    const id = normalizeText(tagId, 256, 'Tag id')
    const tag = normalizeTagInput(input)
    this.db.prepare('update thread_tags set name = ?, color = ?, updated_at = ? where id = ?')
      .run(tag.name, tag.color, nowIso(), id)
    ensureThreadIndexDbFileModes(this.dbPath)
    this.invalidateQueryCache()
    return this.getTag(id)
  }

  getTag(tagId: string): ThreadTag | null {
    const row = this.db.prepare('select * from thread_tags where id = ?').get(tagId) as Row | undefined
    if (!row) return null
    return {
      id: asString(row.id),
      name: asString(row.name),
      color: asString(row.color, THREAD_DEFAULT_TAG_COLOR),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }
  }

  deleteTag(tagId: string) {
    const id = normalizeText(tagId, 256, 'Tag id')
    this.withTransaction(() => {
      this.db.prepare('delete from thread_tag_links where tag_id = ?').run(id)
      this.db.prepare('delete from thread_tags where id = ?').run(id)
    })
    return true
  }

  applyTags(sessionIds: string[], tagIds: string[]) {
    const sessions = normalizeIdList(sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS) || []
    const tags = normalizeIdList(tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES) || []
    const timestamp = nowIso()
    this.withTransaction(() => {
      const insert = this.db.prepare(`
        insert or ignore into thread_tag_links (session_id, tag_id, created_at)
        select ?, ?, ?
        where exists (select 1 from thread_index where session_id = ?)
          and exists (select 1 from thread_tags where id = ?)
      `)
      for (const sessionId of sessions) {
        for (const tagId of tags) {
          insert.run(sessionId, tagId, timestamp, sessionId, tagId)
        }
      }
    })
    return true
  }

  removeTags(sessionIds: string[], tagIds: string[]) {
    const sessions = normalizeIdList(sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS) || []
    const tags = normalizeIdList(tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES) || []
    if (sessions.length === 0 || tags.length === 0) return true
    this.db.prepare(`
      delete from thread_tag_links
      where session_id in (${makePlaceholders(sessions)})
        and tag_id in (${makePlaceholders(tags)})
    `).run(...sessions, ...tags)
    ensureThreadIndexDbFileModes(this.dbPath)
    this.invalidateQueryCache()
    return true
  }

  listSmartFilters(): ThreadSmartFilter[] {
    return (this.db.prepare('select * from thread_smart_filters order by lower(name) asc').all() as Row[]).map((row) => ({
      id: asString(row.id),
      name: asString(row.name),
      query: parseJson<ThreadSearchQuery>(row.query_json, {}),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }))
  }

  getSmartFilter(filterId: string): ThreadSmartFilter | null {
    const row = this.db.prepare('select * from thread_smart_filters where id = ?').get(filterId) as Row | undefined
    if (!row) return null
    return {
      id: asString(row.id),
      name: asString(row.name),
      query: parseJson<ThreadSearchQuery>(row.query_json, {}),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }
  }

  createSmartFilter(input: ThreadSmartFilterInput): ThreadSmartFilter {
    const filter = normalizeSmartFilterInput(input)
    const id = crypto.randomUUID()
    const timestamp = nowIso()
    this.db.prepare(`
      insert into thread_smart_filters (id, name, query_json, created_at, updated_at)
      values (?, ?, ?, ?, ?)
    `).run(id, filter.name, filter.serialized, timestamp, timestamp)
    ensureThreadIndexDbFileModes(this.dbPath)
    this.invalidateQueryCache()
    return this.getSmartFilter(id)!
  }

  updateSmartFilter(filterId: string, input: ThreadSmartFilterInput): ThreadSmartFilter | null {
    const id = normalizeText(filterId, 256, 'Smart filter id')
    const filter = normalizeSmartFilterInput(input)
    this.db.prepare('update thread_smart_filters set name = ?, query_json = ?, updated_at = ? where id = ?')
      .run(filter.name, filter.serialized, nowIso(), id)
    ensureThreadIndexDbFileModes(this.dbPath)
    this.invalidateQueryCache()
    return this.getSmartFilter(id)
  }

  deleteSmartFilter(filterId: string) {
    const id = normalizeText(filterId, 256, 'Smart filter id')
    this.db.prepare('delete from thread_smart_filters where id = ?').run(id)
    ensureThreadIndexDbFileModes(this.dbPath)
    this.invalidateQueryCache()
    return true
  }

  upsertSuggestion(sessionId: string, input: ThreadSuggestionInput, status: ThreadCategorySuggestion['status'] = 'suggested') {
    const id = crypto.randomUUID()
    const timestamp = nowIso()
    const normalized = normalizeSuggestionInput(input)
    this.db.prepare(`
      insert into thread_category_suggestions (id, session_id, label, reason, evidence_json, status, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, normalizeText(sessionId, 256, 'Session id'), normalized.label, normalized.reason, json(normalized.evidence), status, timestamp, timestamp)
    ensureThreadIndexDbFileModes(this.dbPath)
    this.invalidateQueryCache()
    return this.rowToSuggestion(this.db.prepare('select * from thread_category_suggestions where id = ?').get(id) as Row)
  }

  replaceSuggestedSuggestions(sessionId: string, suggestions: ThreadSuggestionInput[]) {
    const id = normalizeText(sessionId, 256, 'Session id')
    this.withTransaction(() => {
      const protectedLabels = new Set((this.db.prepare(`
        select lower(label) as label
        from thread_category_suggestions
        where session_id = ? and status in ('accepted', 'dismissed')
      `).all(id) as Row[]).map((row) => asString(row.label)).filter(Boolean))
      this.db.prepare("delete from thread_category_suggestions where session_id = ? and status = 'suggested'").run(id)
      const insertedLabels = new Set<string>()
      for (const suggestion of suggestions.slice(0, THREAD_FILTER_MAX_VALUES)) {
        const normalized = normalizeSuggestionInput(suggestion)
        const labelKey = normalized.label.toLowerCase()
        if (protectedLabels.has(labelKey) || insertedLabels.has(labelKey)) continue
        insertedLabels.add(labelKey)
        const timestamp = nowIso()
        this.db.prepare(`
          insert into thread_category_suggestions (id, session_id, label, reason, evidence_json, status, created_at, updated_at)
          values (?, ?, ?, ?, ?, 'suggested', ?, ?)
        `).run(crypto.randomUUID(), id, normalized.label, normalized.reason, json(normalized.evidence), timestamp, timestamp)
      }
    })
  }

  acceptSuggestion(suggestionId: string) {
    return this.updateSuggestionStatus(suggestionId, 'accepted')
  }

  dismissSuggestion(suggestionId: string) {
    return this.updateSuggestionStatus(suggestionId, 'dismissed')
  }

  editSuggestion(suggestionId: string, label: string) {
    const id = normalizeText(suggestionId, 256, 'Suggestion id')
    const nextLabel = normalizeText(label, THREAD_SUGGESTION_LABEL_MAX_LENGTH, 'Suggestion label')
    this.db.prepare("update thread_category_suggestions set label = ?, status = 'accepted', updated_at = ? where id = ?")
      .run(nextLabel, nowIso(), id)
    ensureThreadIndexDbFileModes(this.dbPath)
    this.invalidateQueryCache()
    return true
  }

  private updateSuggestionStatus(suggestionId: string, status: ThreadCategorySuggestion['status']) {
    const id = normalizeText(suggestionId, 256, 'Suggestion id')
    this.db.prepare('update thread_category_suggestions set status = ?, updated_at = ? where id = ?')
      .run(status, nowIso(), id)
    ensureThreadIndexDbFileModes(this.dbPath)
    this.invalidateQueryCache()
    return true
  }
}

export function getThreadIndexStore() {
  if (!threadIndexStore) threadIndexStore = new ThreadIndexStore()
  return threadIndexStore
}

export function clearThreadIndexStoreCache() {
  threadIndexStore?.close()
  threadIndexStore = null
}
