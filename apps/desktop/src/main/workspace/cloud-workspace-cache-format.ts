import { rewriteLegacyCacheRecord } from './cloud-workspace-cache-migration.ts'

const CACHE_SCHEMA_VERSION = 2
const ENCRYPTED_PREFIX = Buffer.from('open-cowork-cache:v2:encrypted\n', 'utf8')
const PLAINTEXT_PREFIX = Buffer.from('open-cowork-cache:v2:plaintext\n', 'utf8')

export type CloudWorkspaceCacheFileEncoding = 'encrypted' | 'plaintext' | 'legacy'

export type DecodedCloudWorkspaceCacheDocument<T> = {
  records: T[]
  migratedLegacySensitivePartitions: boolean
  removedSensitiveViews: boolean
}

type NormalizeRecord<T> = (value: unknown) => T | null

export function decodeCacheDocument<T>(
  json: string,
  normalizeRecord: NormalizeRecord<T>,
): DecodedCloudWorkspaceCacheDocument<T> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json) as unknown
  } catch {
    return null
  }
  if (Array.isArray(parsed)) {
    const rewritten = parsed
      .map(rewriteLegacyCacheRecord)
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    return {
      records: rewritten
        .map((entry) => normalizeRecord(entry.record))
        .filter((record): record is T => Boolean(record)),
      migratedLegacySensitivePartitions: true,
      removedSensitiveViews: rewritten.some((entry) => entry.removedSensitiveViews),
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const document = parsed as { schemaVersion?: unknown, records?: unknown }
  if (document.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(document.records)) return null
  return {
    records: document.records
      .map(normalizeRecord)
      .filter((record): record is T => Boolean(record)),
    migratedLegacySensitivePartitions: false,
    removedSensitiveViews: false,
  }
}

export function decodeLegacyPlaintextCache<T>(
  raw: Buffer,
  normalizeRecord: NormalizeRecord<T>,
) {
  return decodeCacheDocument(raw.toString('utf-8'), normalizeRecord)
}

function hasBufferPrefix(value: Buffer, prefix: Buffer) {
  return value.length >= prefix.length && value.subarray(0, prefix.length).equals(prefix)
}

export function decodeCacheFile(raw: Buffer): {
  encoding: CloudWorkspaceCacheFileEncoding
  payload: Buffer
} {
  if (hasBufferPrefix(raw, ENCRYPTED_PREFIX)) {
    return {
      encoding: 'encrypted',
      payload: raw.subarray(ENCRYPTED_PREFIX.length),
    }
  }
  if (hasBufferPrefix(raw, PLAINTEXT_PREFIX)) {
    return {
      encoding: 'plaintext',
      payload: raw.subarray(PLAINTEXT_PREFIX.length),
    }
  }
  return { encoding: 'legacy', payload: raw }
}

export function encodeCacheFile<T>(
  records: T[],
  encoding: Exclude<CloudWorkspaceCacheFileEncoding, 'legacy'>,
  encryptString?: (plaintext: string) => Buffer,
) {
  const json = JSON.stringify({
    schemaVersion: CACHE_SCHEMA_VERSION,
    records,
  }, null, 2)
  if (encoding === 'encrypted') {
    if (!encryptString) throw new Error('Cloud workspace cache encryption is unavailable.')
    return Buffer.concat([ENCRYPTED_PREFIX, encryptString(json)])
  }
  return Buffer.concat([PLAINTEXT_PREFIX, Buffer.from(json, 'utf8')])
}
