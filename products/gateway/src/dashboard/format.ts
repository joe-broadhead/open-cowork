function normalizeSeries(values: number[]): number[] {
  const safe = values.map(value => Number(value || 0)).filter(value => Number.isFinite(value))
  if (safe.length >= 2) return safe
  if (safe.length === 1) return [0, safe[0]!]
  return [0, 0]
}

function seriesValues<T extends Record<string, any>>(series: T[], key: keyof T): number[] {
  return asArray(series).map(point => Number(point[key] || 0))
}
function shortHash(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  return Math.abs(hash).toString(36)
}
function asArray(value: any): any[] {
  return Array.isArray(value) ? value : []
}

function shortId(value: unknown): string {
  const text = String(value || '')
  return text.length > 18 ? `${text.substring(0, 10)}...${text.slice(-4)}` : text
}

function shortPath(value: string): string {
  const home = process.env['HOME'] || ''
  return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value
}

function cleanSessionTitle(value: string): string {
  return value.replace(/^GW:\s*/, '').trim() || value
}

function fmtMoney(value: number): string {
  const safe = Number(value || 0)
  return Math.abs(safe) >= 1 ? `$${safe.toFixed(2)}` : `$${safe.toFixed(4)}`
}

function fmtNumber(value: number): string {
  return Math.round(Number(value || 0)).toLocaleString()
}

function compactNumber(value: number): string {
  const safe = Number(value || 0)
  if (Math.abs(safe) >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}M`
  if (Math.abs(safe) >= 10_000) return `${Math.round(safe / 1000)}k`
  if (Math.abs(safe) >= 1000) return `${(safe / 1000).toFixed(1)}k`
  return fmtNumber(safe)
}

function fmtDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '--'
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}

function timeUntil(value: string): string {
  const ms = Date.parse(value) - Date.now()
  if (!Number.isFinite(ms)) return '--'
  if (ms <= 0) return 'due now'
  return fmtDuration(ms)
}

function formatDateTime(value: string): string {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : value
}

function fmtPct(value: number): string {
  return `${Math.round(Number(value || 0) * 100)}%`
}


export {
  asArray,
  shortId,
  shortPath,
  cleanSessionTitle,
  fmtMoney,
  fmtNumber,
  compactNumber,
  fmtDuration,
  timeUntil,
  formatDateTime,
  fmtPct,
  shortHash,
  normalizeSeries,
  seriesValues,
}
