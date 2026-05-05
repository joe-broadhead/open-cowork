import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ProviderModelDescriptor } from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'
import { dedupByKey } from './inflight-dedup.ts'
import { log } from './logger.ts'

// Config-driven dynamic model catalog. A provider descriptor opts in by
// adding a `dynamicCatalog` block — we fetch the URL, pull models out of
// the response using the configured field paths, and merge them underneath
// the descriptor's hardcoded (featured) models. The fetch is best-effort:
// network failures fall back to disk cache, and disk-cache misses fall back
// to the hardcoded list alone. Everything else in the app keeps working.
//
// Keeping this generic (not OpenRouter-specific) means a downstream
// distribution can swap providers entirely via config — any provider with
// a public "list models" endpoint plugs in the same way.

export type ProviderDynamicCatalog = {
  url: string
  // JSON path to the array of model records in the response body. Accepts
  // dotted paths; empty string / missing means the body itself is the
  // array. E.g. OpenRouter returns `{ data: [...] }` → `responsePath: "data"`.
  responsePath?: string
  idField?: string
  nameField?: string
  descriptionField?: string
  // Optional numeric field for the model's max context window.
  contextLengthField?: string
  // Optional bearer token header; the value may reference an allowed env
  // placeholder via `{env:NAME}` elsewhere in the config pipeline.
  authHeader?: string
  // Optional hex-encoded SHA-256 of the response body. Downstream
  // distributions can pin catalogs they do not fully control.
  sha256?: string
  cacheTtlMinutes?: number
}

type CacheEntry = {
  providerId: string
  fetchedAt: number
  models: ProviderModelDescriptor[]
}

const DEFAULT_TTL_MINUTES = 60
const FETCH_TIMEOUT_MS = 15_000
// Cap on the response body so a misconfigured endpoint can't stream
// megabytes into memory. OpenRouter's full catalog is ~250KB — 8MB gives
// ~30× headroom.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

const memoryCache = new Map<string, CacheEntry>()
// Dedup concurrent fetches for the same provider. Without this, every
// synchronous consumer of `getProviderDescriptors()` during boot racetracks
// its own fetch before the first has populated the cache — we saw ~10
// parallel requests to OpenRouter on cold start.
const inflight = new Map<string, Promise<ProviderModelDescriptor[]>>()

function catalogDir() {
  const dir = join(getAppDataDir(), 'provider-catalogs')
  mkdirSync(dir, { recursive: true })
  return dir
}

function catalogPath(providerId: string) {
  const safe = providerId.replace(/[^a-zA-Z0-9_-]+/g, '_')
  return join(catalogDir(), `${safe}.json`)
}

function readCacheFromDisk(providerId: string): CacheEntry | null {
  const path = catalogPath(providerId)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (raw && typeof raw === 'object' && Array.isArray(raw.models) && typeof raw.fetchedAt === 'number') {
      return {
        providerId,
        fetchedAt: raw.fetchedAt,
        models: raw.models.filter((m: unknown) => isValidModel(m)),
      }
    }
  } catch (err) {
    log('provider', `Failed to read cached catalog for ${providerId}: ${(err as Error).message}`)
  }
  return null
}

function writeCacheToDisk(entry: CacheEntry) {
  try {
    // Atomic write: dodge corruption if the process is killed mid-write
    // or a parallel refresh flushes the same key. Rename is atomic on
    // the same filesystem so readers always see a fully-formed JSON file.
    const target = catalogPath(entry.providerId)
    const tmp = `${target}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(entry, null, 2))
    renameSync(tmp, target)
  } catch (err) {
    log('provider', `Failed to persist catalog for ${entry.providerId}: ${(err as Error).message}`)
  }
}

function isValidModel(value: unknown): value is ProviderModelDescriptor {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.name === 'string'
}

function pickField(record: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return undefined
  const parts = path.split('.')
  let current: unknown = record
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function mapResponseToModels(
  body: unknown,
  catalog: ProviderDynamicCatalog,
): ProviderModelDescriptor[] {
  if (!body || typeof body !== 'object') return []
  const root = catalog.responsePath
    ? pickField(body as Record<string, unknown>, catalog.responsePath)
    : body
  if (!Array.isArray(root)) return []

  const idField = catalog.idField || 'id'
  const nameField = catalog.nameField || 'name'
  const descField = catalog.descriptionField || 'description'
  const contextField = catalog.contextLengthField || 'context_length'

  return root.flatMap((entry): ProviderModelDescriptor[] => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const id = readString(pickField(record, idField))
    if (!id) return []
    const name = readString(pickField(record, nameField)) || id
    const description = readString(pickField(record, descField)) || undefined
    const contextLength = readNumber(pickField(record, contextField)) || undefined
    return [{ id, name, description, contextLength }]
  })
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function isAllowedCatalogUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function responseHashMatches(text: string, expectedSha256?: string) {
  if (!expectedSha256) return true
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) return false
  const actual = createHash('sha256').update(text).digest('hex')
  return actual.toLowerCase() === expectedSha256.toLowerCase()
}

async function readBodyWithLimit(response: Response): Promise<string | null> {
  // Content-Length gives us an early exit when the server reports the size
  // honestly. Streaming the body still guards when it doesn't.
  const contentLengthHeader = response.headers.get('content-length')
  if (contentLengthHeader) {
    const length = Number(contentLengthHeader)
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return null
  }
  if (!response.body) return await response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let out = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      reader.cancel().catch(() => {})
      return null
    }
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

async function fetchCatalog(
  providerId: string,
  catalog: ProviderDynamicCatalog,
): Promise<ProviderModelDescriptor[] | null> {
  if (!isAllowedCatalogUrl(catalog.url)) {
    log('provider', `Catalog ${providerId} skipped: unsupported URL scheme`)
    return null
  }
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (catalog.authHeader) headers.Authorization = catalog.authHeader
    const response = await fetchWithTimeout(
      catalog.url,
      { method: 'GET', headers },
      FETCH_TIMEOUT_MS,
    )
    if (!response.ok) {
      log('provider', `Catalog ${providerId} fetch failed: HTTP ${response.status}`)
      return null
    }
    const text = await readBodyWithLimit(response)
    if (text === null) {
      log('provider', `Catalog ${providerId} fetch aborted: response exceeded ${MAX_RESPONSE_BYTES} bytes`)
      return null
    }
    if (!responseHashMatches(text, catalog.sha256)) {
      log('provider', `Catalog ${providerId} fetch rejected: SHA-256 mismatch`)
      return null
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch (err) {
      log('provider', `Catalog ${providerId} response is not valid JSON: ${(err as Error).message}`)
      return null
    }
    const models = mapResponseToModels(body, catalog)
    log('provider', `Catalog ${providerId} fetched ${models.length} models`)
    return models
  } catch (err) {
    log('provider', `Catalog ${providerId} fetch error: ${(err as Error).message}`)
    return null
  }
}

function ttlExpired(entry: CacheEntry, catalog: ProviderDynamicCatalog) {
  const ttlMs = Math.max(1, catalog.cacheTtlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000
  return Date.now() - entry.fetchedAt >= ttlMs
}

// Synchronous read for the config-loader to use when building the public
// config — we only serve what's already on disk/in memory. A background
// refresh is kicked off separately so the next read picks up fresh data.
export function getCachedProviderCatalog(providerId: string): ProviderModelDescriptor[] {
  const cached = memoryCache.get(providerId) || readCacheFromDisk(providerId)
  if (cached) {
    memoryCache.set(providerId, cached)
    return cached.models
  }
  return []
}

// Force-refetch entry point. Returns the fresh models on success, the
// stale cache on failure, or [] if neither exists. Concurrent callers for
// the same provider share a single in-flight request.
export function refreshProviderCatalog(
  providerId: string,
  catalog: ProviderDynamicCatalog,
): Promise<ProviderModelDescriptor[]> {
  return dedupByKey(inflight, providerId, async () => {
    const models = await fetchCatalog(providerId, catalog)
    if (models && models.length > 0) {
      const entry: CacheEntry = { providerId, fetchedAt: Date.now(), models }
      memoryCache.set(providerId, entry)
      writeCacheToDisk(entry)
      return models
    }
    return getCachedProviderCatalog(providerId)
  })
}

// Best-effort background refresh: if cache is fresh, no-op; if stale, fire
// a fetch in the background. Callers don't await — the next config load
// picks up whatever the fetch produced. An in-flight fetch dedups callers
// so repeated sync reads during boot don't race ten parallel requests.
export function scheduleBackgroundRefresh(
  providerId: string,
  catalog: ProviderDynamicCatalog,
  onRefreshed?: () => void,
) {
  if (inflight.has(providerId)) return
  const cached = memoryCache.get(providerId) || readCacheFromDisk(providerId)
  if (cached) memoryCache.set(providerId, cached)
  if (cached && !ttlExpired(cached, catalog)) return
  void refreshProviderCatalog(providerId, catalog).then((models) => {
    if (models.length === 0 || !onRefreshed) return
    // The callback is provided by the config-loader to invalidate the
    // public-config cache; a throw from it would surface as an unhandled
    // rejection. Isolate so a buggy consumer can't crash the background
    // refresh path.
    try {
      onRefreshed()
    } catch (err) {
      log('provider', `onRefreshed callback threw for ${providerId}: ${(err as Error).message}`)
    }
  })
}
