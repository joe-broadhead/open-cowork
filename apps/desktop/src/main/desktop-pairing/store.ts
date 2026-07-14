import { quarantineCorruptFile, writeFileAtomic } from '@open-cowork/shared/node'
import {
  DEFAULT_DESKTOP_PAIRING_POLICY,
  type DesktopPairingAuditEvent,
  type DesktopPairingCreateInput,
  type DesktopPairingPolicy,
  type DesktopPairingRecord,
  type DesktopPairingUpdateInput,
} from '@open-cowork/shared'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getAppDataDir } from '@open-cowork/runtime-host/config'
import { evaluateDesktopPairingBrokerUrl } from './broker-url-policy.ts'

const MAX_TEXT_BYTES = 512
const MAX_URL_BYTES = 2048
const MAX_ALLOWLIST = 128
const MAX_AUDIT_EVENTS = 5_000
const DESKTOP_PAIRING_STORE_SCHEMA_VERSION = 1
const DESKTOP_PAIRING_STATUSES = new Set<DesktopPairingRecord['status']>([
  'paired_online',
  'paired_offline',
  'disabled',
  'revoked',
  'error',
])
const DESKTOP_PAIRING_AUDIT_ACTIONS = new Set<DesktopPairingAuditEvent['action']>([
  'pairing.created',
  'pairing.updated',
  'pairing.enabled',
  'pairing.disabled',
  'pairing.connected',
  'pairing.offline',
  'pairing.revoked',
  'command.accepted',
  'command.completed',
  'command.failed',
  'command.blocked',
  'remote.event.published',
])
const DESKTOP_PAIRING_RECORD_KEYS = new Set([
  'id',
  'label',
  'deviceName',
  'status',
  'enabled',
  'brokerUrl',
  'allowedWorkspaceIds',
  'allowedSessionIds',
  'policy',
  'lastConnectedAt',
  'lastHeartbeatAt',
  'lastCommandSequence',
  'error',
  'createdAt',
  'updatedAt',
  'revokedAt',
])
const DESKTOP_PAIRING_POLICY_KEYS = new Set([
  'allowRemotePrompts',
  'allowRemoteAbort',
  'remoteApprovals',
  'remoteQuestions',
  'exposeArtifactBodies',
  'exposeLocalPaths',
  'exposeLocalMcpDetails',
  'allowRemoteAttachments',
])
const DESKTOP_PAIRING_STATE_KEYS = new Set(['schemaVersion', 'pairings', 'audit'])
const DESKTOP_PAIRING_AUDIT_REQUIRED_KEYS = new Set([
  'id',
  'pairingId',
  'action',
  'actorId',
  'actorLabel',
  'workspaceId',
  'sessionId',
  'commandId',
  'reason',
  'createdAt',
])
const DESKTOP_PAIRING_AUDIT_ALLOWED_KEYS = new Set([
  ...DESKTOP_PAIRING_AUDIT_REQUIRED_KEYS,
  'metadata',
])

export type DesktopPairingStore = {
  list(): DesktopPairingRecord[]
  get(pairingId: string): DesktopPairingRecord | null
  save(record: DesktopPairingRecord): DesktopPairingRecord
  remove(pairingId: string): boolean
  listAudit(pairingId?: string | null, limit?: number): DesktopPairingAuditEvent[]
  appendAudit(event: DesktopPairingAuditEvent): DesktopPairingAuditEvent
}

function defaultStorePath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'desktop-pairings.json')
}

function byteLength(value: string) {
  return Buffer.byteLength(value, 'utf8')
}

function boundedText(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const trimmed = value.trim()
  if (byteLength(trimmed) > maxBytes) throw new Error(`${label} is too large.`)
  return trimmed
}

function optionalText(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  if (value === undefined || value === null || value === '') return undefined
  return boundedText(value, label, maxBytes)
}

function nullableText(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  if (value === undefined || value === null || value === '') return null
  return boundedText(value, label, maxBytes)
}

function normalizeIso(value: unknown, label: string, fallback?: string | null) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO timestamp.`)
  return new Date(time).toISOString()
}

function normalizeRequiredIso(value: unknown, label: string) {
  const normalized = normalizeIso(value, label)
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

export function normalizeDesktopPairingBrokerUrl(value: unknown) {
  const raw = nullableText(value, 'Desktop pairing broker URL', MAX_URL_BYTES)
  if (!raw) return null
  const verdict = evaluateDesktopPairingBrokerUrl(raw)
  if (!verdict.ok) throw new Error(verdict.reason)
  const parsed = verdict.url
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/+$/, '')
}

function normalizeId(value: unknown, label = 'Desktop pairing id') {
  const id = boundedText(value, label)
  if (byteLength(id) > 256) throw new Error(`${label} is too large.`)
  return id
}

function normalizeStringList(value: unknown, label: string, fallback: string[]) {
  if (value === undefined || value === null) return fallback
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  if (value.length > MAX_ALLOWLIST) throw new Error(`${label} is too large.`)
  const entries = value
    .map((entry) => boundedText(entry, label, 256))
    .filter(Boolean)
  return Array.from(new Set(entries))
}

function normalizeNullableStringList(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (value === null) return null
  return normalizeStringList(value, label, [])
}

function normalizeDecisionPolicy(value: unknown, fallback: DesktopPairingPolicy['remoteApprovals']) {
  if (value === 'disabled' || value === 'local_confirmation' || value === 'remote_allowed') return value
  return fallback
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>) {
  const actual = Object.keys(value)
  return actual.length === keys.size && actual.every((key) => keys.has(key))
}

function hasRequiredAllowedKeys(
  value: Record<string, unknown>,
  requiredKeys: ReadonlySet<string>,
  allowedKeys: ReadonlySet<string>,
) {
  const actual = Object.keys(value)
  return actual.every((key) => allowedKeys.has(key))
    && [...requiredKeys].every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isExactPersistedPolicy(value: unknown): value is DesktopPairingPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const policy = value as Record<string, unknown>
  if (!hasExactKeys(policy, DESKTOP_PAIRING_POLICY_KEYS)) return false
  return typeof policy.allowRemotePrompts === 'boolean'
    && typeof policy.allowRemoteAbort === 'boolean'
    && (policy.remoteApprovals === 'disabled' || policy.remoteApprovals === 'local_confirmation' || policy.remoteApprovals === 'remote_allowed')
    && (policy.remoteQuestions === 'disabled' || policy.remoteQuestions === 'local_confirmation' || policy.remoteQuestions === 'remote_allowed')
    && typeof policy.exposeArtifactBodies === 'boolean'
    && typeof policy.exposeLocalPaths === 'boolean'
    && typeof policy.exposeLocalMcpDetails === 'boolean'
    && typeof policy.allowRemoteAttachments === 'boolean'
}

function isExactPersistedPairingRecord(value: unknown): value is DesktopPairingRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!hasExactKeys(record, DESKTOP_PAIRING_RECORD_KEYS)) return false
  return typeof record.id === 'string'
    && typeof record.label === 'string'
    && typeof record.deviceName === 'string'
    && DESKTOP_PAIRING_STATUSES.has(record.status as DesktopPairingRecord['status'])
    && typeof record.enabled === 'boolean'
    && isStringOrNull(record.brokerUrl)
    && isStringList(record.allowedWorkspaceIds)
    && (record.allowedSessionIds === null || isStringList(record.allowedSessionIds))
    && isExactPersistedPolicy(record.policy)
    && isStringOrNull(record.lastConnectedAt)
    && isStringOrNull(record.lastHeartbeatAt)
    && Number.isSafeInteger(record.lastCommandSequence)
    && Number(record.lastCommandSequence) >= 0
    && isStringOrNull(record.error)
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && isStringOrNull(record.revokedAt)
}

export function normalizeDesktopPairingPolicy(
  value: unknown,
  fallback: DesktopPairingPolicy = DEFAULT_DESKTOP_PAIRING_POLICY,
): DesktopPairingPolicy {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<DesktopPairingPolicy>
    : {}
  return {
    allowRemotePrompts: typeof input.allowRemotePrompts === 'boolean' ? input.allowRemotePrompts : fallback.allowRemotePrompts,
    allowRemoteAbort: typeof input.allowRemoteAbort === 'boolean' ? input.allowRemoteAbort : fallback.allowRemoteAbort,
    remoteApprovals: normalizeDecisionPolicy(input.remoteApprovals, fallback.remoteApprovals),
    remoteQuestions: normalizeDecisionPolicy(input.remoteQuestions, fallback.remoteQuestions),
    exposeArtifactBodies: typeof input.exposeArtifactBodies === 'boolean' ? input.exposeArtifactBodies : fallback.exposeArtifactBodies,
    exposeLocalPaths: typeof input.exposeLocalPaths === 'boolean' ? input.exposeLocalPaths : fallback.exposeLocalPaths,
    exposeLocalMcpDetails: typeof input.exposeLocalMcpDetails === 'boolean' ? input.exposeLocalMcpDetails : fallback.exposeLocalMcpDetails,
    allowRemoteAttachments: typeof input.allowRemoteAttachments === 'boolean' ? input.allowRemoteAttachments : fallback.allowRemoteAttachments,
  }
}

export function buildDesktopPairingRecord(input: {
  id: string
  now: Date
  create: DesktopPairingCreateInput
}): DesktopPairingRecord {
  const timestamp = input.now.toISOString()
  const allowedWorkspaceIds = normalizeStringList(input.create.allowedWorkspaceIds, 'Allowed workspace ids', ['local'])
  if (!allowedWorkspaceIds.includes('local')) {
    throw new Error('Desktop pairing must allow the Local workspace explicitly.')
  }
  return {
    id: normalizeId(input.id),
    label: boundedText(input.create.label, 'Desktop pairing label'),
    deviceName: optionalText(input.create.deviceName, 'Desktop pairing device name') || 'Desktop',
    status: input.create.enabled ? 'paired_offline' : 'disabled',
    enabled: input.create.enabled === true,
    brokerUrl: normalizeDesktopPairingBrokerUrl(input.create.brokerUrl),
    allowedWorkspaceIds,
    allowedSessionIds: normalizeNullableStringList(input.create.allowedSessionIds, 'Allowed session ids') ?? null,
    policy: normalizeDesktopPairingPolicy(input.create.policy),
    lastConnectedAt: null,
    lastHeartbeatAt: null,
    lastCommandSequence: 0,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    revokedAt: null,
  }
}

export function updateDesktopPairingRecord(
  existing: DesktopPairingRecord,
  input: DesktopPairingUpdateInput,
  now = new Date(),
): DesktopPairingRecord {
  if (existing.status === 'revoked') throw new Error('Revoked desktop pairings cannot be updated.')
  const allowedWorkspaceIds = input.allowedWorkspaceIds === undefined
    ? existing.allowedWorkspaceIds
    : normalizeStringList(input.allowedWorkspaceIds, 'Allowed workspace ids', existing.allowedWorkspaceIds)
  if (!allowedWorkspaceIds.includes('local')) {
    throw new Error('Desktop pairing must allow the Local workspace explicitly.')
  }
  const enabled = input.enabled ?? existing.enabled
  return {
    ...existing,
    ...(input.label !== undefined ? { label: boundedText(input.label, 'Desktop pairing label') } : {}),
    ...(input.deviceName !== undefined ? { deviceName: boundedText(input.deviceName, 'Desktop pairing device name') } : {}),
    ...(input.brokerUrl !== undefined ? { brokerUrl: normalizeDesktopPairingBrokerUrl(input.brokerUrl) } : {}),
    enabled,
    status: enabled ? existing.status === 'disabled' ? 'paired_offline' : existing.status : 'disabled',
    allowedWorkspaceIds,
    ...(input.allowedSessionIds !== undefined ? { allowedSessionIds: normalizeNullableStringList(input.allowedSessionIds, 'Allowed session ids') } : {}),
    ...(input.policy !== undefined ? { policy: normalizeDesktopPairingPolicy(input.policy, existing.policy) } : {}),
    updatedAt: now.toISOString(),
  }
}

function normalizeRecord(value: unknown): DesktopPairingRecord | null {
  if (!isExactPersistedPairingRecord(value)) return null
  const raw = value
  try {
    const policy = raw.policy
    const status = raw.status
    const allowedWorkspaceIds = normalizeStringList(raw.allowedWorkspaceIds, 'Allowed workspace ids', [])
    if (!allowedWorkspaceIds.includes('local')) throw new Error('Desktop pairing must allow the Local workspace explicitly.')
    return {
      id: normalizeId(raw.id),
      label: boundedText(raw.label, 'Desktop pairing label'),
      deviceName: boundedText(raw.deviceName, 'Desktop pairing device name'),
      status,
      enabled: status === 'revoked' ? false : raw.enabled,
      brokerUrl: normalizeDesktopPairingBrokerUrl(raw.brokerUrl),
      allowedWorkspaceIds,
      allowedSessionIds: Array.isArray(raw.allowedSessionIds)
        ? normalizeStringList(raw.allowedSessionIds, 'Allowed session ids', [])
        : null,
      policy,
      lastConnectedAt: normalizeIso(raw.lastConnectedAt, 'Desktop pairing last connection time', null),
      lastHeartbeatAt: normalizeIso(raw.lastHeartbeatAt, 'Desktop pairing last heartbeat time', null),
      lastCommandSequence: raw.lastCommandSequence,
      error: nullableText(raw.error, 'Desktop pairing error'),
      createdAt: normalizeRequiredIso(raw.createdAt, 'Desktop pairing creation time'),
      updatedAt: normalizeRequiredIso(raw.updatedAt, 'Desktop pairing update time'),
      revokedAt: normalizeIso(raw.revokedAt, 'Desktop pairing revocation time', null),
    }
  } catch {
    return null
  }
}

function normalizeAuditEvent(value: unknown): DesktopPairingAuditEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!hasRequiredAllowedKeys(
    record,
    DESKTOP_PAIRING_AUDIT_REQUIRED_KEYS,
    DESKTOP_PAIRING_AUDIT_ALLOWED_KEYS,
  )) return null
  if (
    !isStringOrNull(record.actorId)
    || !isStringOrNull(record.actorLabel)
    || !isStringOrNull(record.workspaceId)
    || !isStringOrNull(record.sessionId)
    || !isStringOrNull(record.commandId)
    || !isStringOrNull(record.reason)
    || (record.metadata !== undefined && (
      !record.metadata
      || typeof record.metadata !== 'object'
      || Array.isArray(record.metadata)
    ))
  ) return null
  const raw = record as DesktopPairingAuditEvent
  try {
    if (!DESKTOP_PAIRING_AUDIT_ACTIONS.has(raw.action as DesktopPairingAuditEvent['action'])) return null
    return {
      id: normalizeId(raw.id, 'Desktop pairing audit id'),
      pairingId: normalizeId(raw.pairingId),
      action: boundedText(raw.action, 'Desktop pairing audit action') as DesktopPairingAuditEvent['action'],
      actorId: nullableText(raw.actorId, 'Desktop pairing audit actor id'),
      actorLabel: nullableText(raw.actorLabel, 'Desktop pairing audit actor label'),
      workspaceId: nullableText(raw.workspaceId, 'Desktop pairing audit workspace id'),
      sessionId: nullableText(raw.sessionId, 'Desktop pairing audit session id'),
      commandId: nullableText(raw.commandId, 'Desktop pairing audit command id'),
      reason: nullableText(raw.reason, 'Desktop pairing audit reason'),
      ...(raw.metadata ? { metadata: raw.metadata } : {}),
      createdAt: normalizeRequiredIso(raw.createdAt, 'Desktop pairing audit creation time'),
    }
  } catch {
    return null
  }
}

function sortRecords(records: DesktopPairingRecord[]) {
  return records.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

type DesktopPairingState = { pairings: DesktopPairingRecord[]; audit: DesktopPairingAuditEvent[] }
type DesktopPairingStateFile = DesktopPairingState & {
  schemaVersion: typeof DESKTOP_PAIRING_STORE_SCHEMA_VERSION
}

export class FileDesktopPairingStore implements DesktopPairingStore {
  private readonly path: string
  // In-memory cache of the parsed+normalized state, keyed on the file's mtime.
  // readState() runs on every store op — including observeRuntimeEvent, which
  // fires per runtime session event — and re-parsing + re-normalizing up to
  // MAX_AUDIT_EVENTS entries each time blocked the Electron main loop. This
  // store is the sole writer, so we refresh the cache on write and fall back to
  // an mtime check to pick up any out-of-band edit. Callers never mutate the
  // returned arrays in place (they slice/spread/filter), so sharing by ref is safe.
  private cache: { mtimeMs: number; state: DesktopPairingState } | null = null

  constructor(path = defaultStorePath()) {
    this.path = path
  }

  list(): DesktopPairingRecord[] {
    return sortRecords(this.readState().pairings)
  }

  get(pairingId: string): DesktopPairingRecord | null {
    const id = normalizeId(pairingId)
    return this.readState().pairings.find((record) => record.id === id) || null
  }

  save(record: DesktopPairingRecord): DesktopPairingRecord {
    const normalized = normalizeRecord(record)
    if (!normalized) throw new Error('Desktop pairing record is invalid.')
    const state = this.readState()
    const pairings = state.pairings.some((entry) => entry.id === normalized.id)
      ? state.pairings.map((entry) => entry.id === normalized.id ? normalized : entry)
      : [...state.pairings, normalized]
    this.writeState({ pairings, audit: state.audit })
    return normalized
  }

  remove(pairingId: string): boolean {
    const id = normalizeId(pairingId)
    const state = this.readState()
    const pairings = state.pairings.filter((record) => record.id !== id)
    if (pairings.length === state.pairings.length) return false
    this.writeState({ ...state, pairings })
    return true
  }

  listAudit(pairingId?: string | null, limit = 100): DesktopPairingAuditEvent[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)))
    const events = this.readState().audit
      .filter((event) => !pairingId || event.pairingId === pairingId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    return events.slice(0, boundedLimit)
  }

  appendAudit(event: DesktopPairingAuditEvent): DesktopPairingAuditEvent {
    const normalized = normalizeAuditEvent(event)
    if (!normalized) throw new Error('Desktop pairing audit event is invalid.')
    const state = this.readState()
    const audit = [...state.audit, normalized]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(-MAX_AUDIT_EVENTS)
    this.writeState({ pairings: state.pairings, audit })
    return normalized
  }

  private readState(): DesktopPairingState {
    if (!existsSync(this.path)) {
      this.cache = null
      return { pairings: [], audit: [] }
    }
    const mtimeMs = this.currentMtimeMs()
    if (this.cache && mtimeMs !== null && this.cache.mtimeMs === mtimeMs) return this.cache.state
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Desktop pairing state must be an object.')
      }
      const record = parsed as Partial<DesktopPairingStateFile>
      if (
        !hasExactKeys(record as Record<string, unknown>, DESKTOP_PAIRING_STATE_KEYS)
        || record.schemaVersion !== DESKTOP_PAIRING_STORE_SCHEMA_VERSION
        || !Array.isArray(record.pairings)
        || !Array.isArray(record.audit)
      ) {
        throw new Error('Desktop pairing state schema is not current.')
      }
      const pairings = record.pairings.map(normalizeRecord)
      const audit = record.audit.map(normalizeAuditEvent)
      if (pairings.some((entry) => !entry) || audit.some((entry) => !entry)) {
        throw new Error('Desktop pairing state contains a non-current record.')
      }
      const state: DesktopPairingState = {
        pairings: pairings as DesktopPairingRecord[],
        audit: audit as DesktopPairingAuditEvent[],
      }
      if (mtimeMs !== null) this.cache = { mtimeMs, state }
      return state
    } catch {
      // A corrupt/half-written file is NOT "no pairings" (audit P2-13): quarantine it to .corrupt so
      // the good-but-unreadable data is preserved for recovery and the next writeState can't clobber
      // it down to only the newest entry.
      quarantineCorruptFile(this.path)
      this.cache = null
      return { pairings: [], audit: [] }
    }
  }

  private writeState(state: DesktopPairingState) {
    const pairings = sortRecords(state.pairings).map(normalizeRecord)
    const audit = state.audit.map(normalizeAuditEvent).slice(-MAX_AUDIT_EVENTS)
    if (pairings.some((entry) => !entry) || audit.some((entry) => !entry)) {
      throw new Error('Desktop pairing state contains a non-current record.')
    }
    const safeState: DesktopPairingState = {
      pairings: pairings as DesktopPairingRecord[],
      audit: audit as DesktopPairingAuditEvent[],
    }
    const payload: DesktopPairingStateFile = {
      schemaVersion: DESKTOP_PAIRING_STORE_SCHEMA_VERSION,
      ...safeState,
    }
    writeFileAtomic(this.path, JSON.stringify(payload, null, 2), { mode: 0o600 })
    const mtimeMs = this.currentMtimeMs()
    this.cache = mtimeMs !== null ? { mtimeMs, state: safeState } : null
  }

  private currentMtimeMs(): number | null {
    try {
      return statSync(this.path).mtimeMs
    } catch {
      return null
    }
  }
}

export function createFileDesktopPairingStore(path?: string) {
  return new FileDesktopPairingStore(path)
}
