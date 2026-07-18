import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { opencodeSessionWebUrl } from './opencode-web.js'

export type UsageRangePreset =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'this-week'
  | 'last-week'
  | 'this-month'
  | 'last-month'
  | 'ytd'
  | 'last-year'
  | 'all'
  | 'custom'

export interface UsageWindow {
  preset: UsageRangePreset
  label: string
  startMs: number
  endMs: number
  startDate: string
  endDate: string
}

export interface UsageTotals {
  sessions: number
  messages: number
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cacheHits: number
  tokenBurn: number
  cacheHitRate: number
}

export interface UsageBreakdownRow extends UsageTotals {
  key: string
  label: string
}

export interface UsageSessionRow extends UsageTotals {
  id: string
  title: string
  agent: string
  model: string
  created: number
  updated: number
  webUrl?: string
}

export interface UsageSeriesPoint {
  date: string
  cost: number
  tokens: number
  sessions: number
}

export interface OpenCodeUsageReport {
  available: boolean
  source: string
  dbPath?: string
  error?: string
  window: UsageWindow
  totals: UsageTotals
  byModel: UsageBreakdownRow[]
  byAgent: UsageBreakdownRow[]
  topSessions: UsageSessionRow[]
  series: UsageSeriesPoint[]
}

const PRESETS: UsageRangePreset[] = ['today', 'yesterday', 'last7', 'last30', 'this-week', 'last-week', 'this-month', 'last-month', 'ytd', 'last-year', 'all']
const USAGE_CACHE_TTL_MS = 5000
const USAGE_SERIES_LIMIT_DAYS = 60
let cachedDbPath: string | undefined
const usageCache = new Map<string, { expiresAt: number; dbMtimeMs: number; report: OpenCodeUsageReport }>()

export function usagePresetOptions(): UsageRangePreset[] {
  return PRESETS
}

export function buildUsageWindow(params?: URLSearchParams, now = new Date()): UsageWindow {
  const range = normalizePreset(params?.get('range'))
  const customFrom = params?.get('from')
  const customTo = params?.get('to')
  if (range === 'custom' && isDateInput(customFrom) && isDateInput(customTo)) {
    const start = localDate(customFrom!)
    const end = addDays(localDate(customTo!), 1)
    if (end.getTime() > start.getTime()) {
      return makeWindow('custom', `${formatShortDate(start)} - ${formatShortDate(addDays(end, -1))}`, start, end)
    }
  }

  const today = startOfDay(now)
  const tomorrow = addDays(today, 1)
  switch (range) {
    case 'yesterday':
      return makeWindow('yesterday', 'Yesterday', addDays(today, -1), today)
    case 'last7':
      return makeWindow('last7', 'Last 7 days', addDays(now, -7), now)
    case 'last30':
      return makeWindow('last30', 'Last 30 days', addDays(now, -30), now)
    case 'this-week': {
      return makeWindow('this-week', 'This week', startOfWeek(now), now)
    }
    case 'last-week': {
      const start = addDays(startOfWeek(now), -7)
      return makeWindow('last-week', 'Last week', start, addDays(start, 7))
    }
    case 'this-month':
      return makeWindow('this-month', 'This month', new Date(now.getFullYear(), now.getMonth(), 1), now)
    case 'last-month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      return makeWindow('last-month', 'Last month', start, new Date(now.getFullYear(), now.getMonth(), 1))
    }
    case 'ytd':
      return makeWindow('ytd', 'Year to date', new Date(now.getFullYear(), 0, 1), now)
    case 'last-year':
      return makeWindow('last-year', 'Last year', new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear(), 0, 1))
    case 'all':
      return makeWindow('all', 'All time', new Date(0), tomorrow)
    case 'today':
    case 'custom':
    default:
      return makeWindow('today', 'Today', today, tomorrow)
  }
}

export function getOpenCodeUsage(input: { window?: UsageWindow; dbPath?: string; opencodeUrl?: string } = {}): OpenCodeUsageReport {
  const usageWindow = input.window || buildUsageWindow()
  try {
    const resolved = input.dbPath || resolveOpenCodeDbPath()
    if (!resolved) throw new Error('OpenCode database path is unavailable')
    const now = Date.now()
    const dbMtimeMs = fileMtimeMs(resolved)
    const cacheKey = [resolved, usageWindow.startMs, usageWindow.endMs, input.opencodeUrl || ''].join('|')
    const cached = usageCache.get(cacheKey)
    if (cached && cached.expiresAt > now && cached.dbMtimeMs === dbMtimeMs) return cached.report
    const report = readUsageFromDb(resolved, usageWindow, input.opencodeUrl)
    usageCache.set(cacheKey, { expiresAt: now + USAGE_CACHE_TTL_MS, dbMtimeMs, report })
    return report
  } catch (err: any) {
    return emptyUsageReport(usageWindow, err?.message || String(err))
  }
}

export function resolveOpenCodeDbPath(): string {
  if (process.env['OPENCODE_DB_PATH']) return process.env['OPENCODE_DB_PATH']
  if (cachedDbPath) return cachedDbPath
  try {
    const out = execFileSync('opencode', ['db', 'path', '--pure'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
    if (out) {
      cachedDbPath = out
      return out
    }
  } catch {}
  cachedDbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
  return cachedDbPath
}


function fileMtimeMs(file: string): number {
  try { return fs.statSync(file).mtimeMs } catch { return -1 }
}

function readUsageFromDb(dbPath: string, usageWindow: UsageWindow, opencodeUrl?: string): OpenCodeUsageReport {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON')
    const totals = normalizeTotals(db.prepare(usageTotalsSql()).get(usageWindow.startMs, usageWindow.endMs) as Record<string, unknown>)
    const byModel = (db.prepare(usageBreakdownSql('model')).all(usageWindow.startMs, usageWindow.endMs) as Record<string, unknown>[])
      .map(row => normalizeBreakdown(row, String(row['label'] || 'unknown model')))
    const byAgent = (db.prepare(usageBreakdownSql('agent')).all(usageWindow.startMs, usageWindow.endMs) as Record<string, unknown>[])
      .map(row => normalizeBreakdown(row, String(row['label'] || 'unknown agent')))
    const topSessions = (db.prepare(topSessionsSql()).all(usageWindow.startMs, usageWindow.endMs) as Record<string, unknown>[])
      .map(row => normalizeSession(row, opencodeUrl))
    const series = (db.prepare(usageSeriesSql()).all(usageWindow.startMs, usageWindow.endMs) as Record<string, unknown>[])
      .map(normalizeSeriesPoint)

    return {
      available: true,
      source: 'opencode.db',
      dbPath,
      window: usageWindow,
      totals,
      byModel,
      byAgent,
      topSessions,
      series,
    }
  } finally {
    db.close()
  }
}

function usageTotalsSql(): string {
  return `
    select
      count(distinct session_id) as sessions,
      count(*) as messages,
      coalesce(sum(cast(json_extract(data, '$.cost') as real)), 0) as cost,
      coalesce(sum(cast(json_extract(data, '$.tokens.input') as integer)), 0) as input,
      coalesce(sum(cast(json_extract(data, '$.tokens.output') as integer)), 0) as output,
      coalesce(sum(cast(json_extract(data, '$.tokens.reasoning') as integer)), 0) as reasoning,
      coalesce(sum(cast(json_extract(data, '$.tokens.cache.read') as integer)), 0) as cacheRead,
      coalesce(sum(cast(json_extract(data, '$.tokens.cache.write') as integer)), 0) as cacheWrite,
      coalesce(sum(case when cast(json_extract(data, '$.tokens.cache.read') as integer) > 0 then 1 else 0 end), 0) as cacheHits
    from message
    where time_created >= ? and time_created < ?
  `
}

function usageBreakdownSql(kind: 'model' | 'agent'): string {
  const label = kind === 'model'
    ? `coalesce(json_extract(data, '$.providerID') || '/' || json_extract(data, '$.modelID'), json_extract(data, '$.modelID'), 'unknown')`
    : `coalesce(json_extract(data, '$.agent'), 'unknown')`
  return `
    select
      ${label} as label,
      count(distinct session_id) as sessions,
      count(*) as messages,
      coalesce(sum(cast(json_extract(data, '$.cost') as real)), 0) as cost,
      coalesce(sum(cast(json_extract(data, '$.tokens.input') as integer)), 0) as input,
      coalesce(sum(cast(json_extract(data, '$.tokens.output') as integer)), 0) as output,
      coalesce(sum(cast(json_extract(data, '$.tokens.reasoning') as integer)), 0) as reasoning,
      coalesce(sum(cast(json_extract(data, '$.tokens.cache.read') as integer)), 0) as cacheRead,
      coalesce(sum(cast(json_extract(data, '$.tokens.cache.write') as integer)), 0) as cacheWrite,
      coalesce(sum(case when cast(json_extract(data, '$.tokens.cache.read') as integer) > 0 then 1 else 0 end), 0) as cacheHits
    from message
    where time_created >= ? and time_created < ?
    group by label
    order by cost desc, input + output + reasoning + cacheRead + cacheWrite desc
    limit 8
  `
}

function topSessionsSql(): string {
  return `
    select
      s.id as id,
      coalesce(s.title, m.session_id) as title,
      coalesce(s.agent, json_extract(m.data, '$.agent'), 'unknown') as agent,
      coalesce(s.model, json_extract(m.data, '$.providerID') || '/' || json_extract(m.data, '$.modelID'), json_extract(m.data, '$.modelID'), 'unknown') as model,
      coalesce(s.directory, '') as directory,
      coalesce(s.path, '') as path,
      coalesce(s.time_created, min(m.time_created)) as created,
      coalesce(s.time_updated, max(m.time_created)) as updated,
      count(distinct m.session_id) as sessions,
      count(*) as messages,
      coalesce(sum(cast(json_extract(m.data, '$.cost') as real)), 0) as cost,
      coalesce(sum(cast(json_extract(m.data, '$.tokens.input') as integer)), 0) as input,
      coalesce(sum(cast(json_extract(m.data, '$.tokens.output') as integer)), 0) as output,
      coalesce(sum(cast(json_extract(m.data, '$.tokens.reasoning') as integer)), 0) as reasoning,
      coalesce(sum(cast(json_extract(m.data, '$.tokens.cache.read') as integer)), 0) as cacheRead,
      coalesce(sum(cast(json_extract(m.data, '$.tokens.cache.write') as integer)), 0) as cacheWrite,
      coalesce(sum(case when cast(json_extract(m.data, '$.tokens.cache.read') as integer) > 0 then 1 else 0 end), 0) as cacheHits
    from message m
    join session s on s.id = m.session_id
    where m.time_created >= ? and m.time_created < ?
    group by s.id
    order by cost desc, input + output + reasoning + cacheRead + cacheWrite desc
    limit 10
  `
}

function usageSeriesSql(): string {
  return `
    select * from (
      select
        date(time_created / 1000, 'unixepoch') as date,
        coalesce(sum(cast(json_extract(data, '$.cost') as real)), 0) as cost,
        coalesce(sum(
          coalesce(cast(json_extract(data, '$.tokens.input') as integer), 0) +
          coalesce(cast(json_extract(data, '$.tokens.output') as integer), 0) +
          coalesce(cast(json_extract(data, '$.tokens.reasoning') as integer), 0) +
          coalesce(cast(json_extract(data, '$.tokens.cache.read') as integer), 0) +
          coalesce(cast(json_extract(data, '$.tokens.cache.write') as integer), 0)
        ), 0) as tokens,
        count(distinct session_id) as sessions
      from message
      where time_created >= ? and time_created < ?
      group by date
      order by date desc
      limit ${USAGE_SERIES_LIMIT_DAYS}
    ) order by date asc
  `
}

function normalizeSeriesPoint(row: Record<string, unknown>): UsageSeriesPoint {
  return {
    date: String(row['date'] || ''),
    cost: numberValue(row['cost']),
    tokens: numberValue(row['tokens']),
    sessions: numberValue(row['sessions']),
  }
}

function normalizeBreakdown(row: Record<string, unknown>, fallback: string): UsageBreakdownRow {
  return { key: fallback, label: fallback, ...normalizeTotals(row) }
}

function normalizeSession(row: Record<string, unknown>, opencodeUrl?: string): UsageSessionRow {
  const totals = normalizeTotals(row)
  const session = {
    id: String(row['id'] || ''),
    title: String(row['title'] || row['id'] || 'session'),
    agent: String(row['agent'] || 'unknown'),
    model: String(row['model'] || 'unknown'),
    created: numberValue(row['created']),
    updated: numberValue(row['updated']),
    ...totals,
  }
  const directory = String(row['directory'] || '')
  const sessionPath = String(row['path'] || '')
  return {
    ...session,
    webUrl: opencodeUrl && session.id ? opencodeSessionWebUrl(opencodeUrl, { id: session.id, directory, path: sessionPath }) : undefined,
  }
}

function normalizeTotals(row: Record<string, unknown> = {}): UsageTotals {
  const totals = {
    sessions: numberValue(row['sessions']),
    messages: numberValue(row['messages']),
    cost: numberValue(row['cost']),
    input: numberValue(row['input']),
    output: numberValue(row['output']),
    reasoning: numberValue(row['reasoning']),
    cacheRead: numberValue(row['cacheRead']),
    cacheWrite: numberValue(row['cacheWrite']),
    cacheHits: numberValue(row['cacheHits']),
    tokenBurn: 0,
    cacheHitRate: 0,
  }
  totals.tokenBurn = totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite
  totals.cacheHitRate = totals.input + totals.cacheRead > 0 ? totals.cacheRead / (totals.input + totals.cacheRead) : 0
  return totals
}

function emptyUsageReport(usageWindow: UsageWindow, error?: string): OpenCodeUsageReport {
  return {
    available: false,
    source: 'unavailable',
    error,
    window: usageWindow,
    totals: normalizeTotals(),
    byModel: [],
    byAgent: [],
    topSessions: [],
    series: [],
  }
}

function normalizePreset(value: string | null | undefined): UsageRangePreset {
  if (value === 'custom') return 'custom'
  return PRESETS.includes(value as UsageRangePreset) ? value as UsageRangePreset : 'today'
}

function makeWindow(preset: UsageRangePreset, label: string, start: Date, end: Date): UsageWindow {
  const inclusiveEnd = isStartOfDay(end) ? addDays(end, -1) : end
  return {
    preset,
    label,
    startMs: start.getTime(),
    endMs: end.getTime(),
    startDate: dateInput(start),
    endDate: dateInput(inclusiveEnd),
  }
}

function isStartOfDay(date: Date): boolean {
  return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function startOfWeek(date: Date): Date {
  const day = date.getDay() || 7
  return addDays(startOfDay(date), 1 - day)
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function localDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1)
}

function dateInput(date: Date): string {
  if (date.getTime() === 0) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isDateInput(value: string | null | undefined): boolean {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

function numberValue(value: unknown): number {
  const n = Number(value || 0)
  return Number.isFinite(n) ? n : 0
}
