import { writeFileAtomic } from '@open-cowork/shared/node'
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
import { getAppDataDir } from '../config-loader.ts'
import { evaluateDesktopPairingBrokerUrl } from './broker-url-policy.ts'

const MAX_TEXT_BYTES = 512
const MAX_URL_BYTES = 2048
const MAX_ALLOWLIST = 128
const MAX_AUDIT_EVENTS = 5_000

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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<DesktopPairingRecord>
  try {
    const policy = normalizeDesktopPairingPolicy(raw.policy)
    const status = raw.status === 'paired_online'
      || raw.status === 'paired_offline'
      || raw.status === 'disabled'
      || raw.status === 'revoked'
      || raw.status === 'error'
      ? raw.status
      : raw.enabled ? 'paired_offline' : 'disabled'
    const allowedWorkspaceIds = normalizeStringList(raw.allowedWorkspaceIds, 'Allowed workspace ids', ['local'])
    if (!allowedWorkspaceIds.includes('local')) throw new Error('Desktop pairing must allow the Local workspace explicitly.')
    return {
      id: normalizeId(raw.id),
      label: boundedText(raw.label, 'Desktop pairing label'),
      deviceName: optionalText(raw.deviceName, 'Desktop pairing device name') || 'Desktop',
      status,
      enabled: status === 'revoked'
        ? false
        : typeof raw.enabled === 'boolean' ? raw.enabled : status !== 'disabled',
      brokerUrl: normalizeDesktopPairingBrokerUrl(raw.brokerUrl),
      allowedWorkspaceIds,
      allowedSessionIds: Array.isArray(raw.allowedSessionIds)
        ? normalizeStringList(raw.allowedSessionIds, 'Allowed session ids', [])
        : null,
      policy,
      lastConnectedAt: normalizeIso(raw.lastConnectedAt, 'Desktop pairing last connection time', null),
      lastHeartbeatAt: normalizeIso(raw.lastHeartbeatAt, 'Desktop pairing last heartbeat time', null),
      lastCommandSequence: typeof raw.lastCommandSequence === 'number' && Number.isFinite(raw.lastCommandSequence)
        ? Math.max(0, Math.floor(raw.lastCommandSequence))
        : 0,
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
  const raw = value as Partial<DesktopPairingAuditEvent>
  try {
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
      metadata: raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
        ? raw.metadata as Record<string, unknown>
        : undefined,
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
      const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as { pairings?: unknown; audit?: unknown }
        : {}
      const state: DesktopPairingState = {
        pairings: Array.isArray(record.pairings)
          ? record.pairings.map(normalizeRecord).filter((entry): entry is DesktopPairingRecord => Boolean(entry))
          : [],
        audit: Array.isArray(record.audit)
          ? record.audit.map(normalizeAuditEvent).filter((entry): entry is DesktopPairingAuditEvent => Boolean(entry))
          : [],
      }
      if (mtimeMs !== null) this.cache = { mtimeMs, state }
      return state
    } catch {
      this.cache = null
      return { pairings: [], audit: [] }
    }
  }

  private writeState(state: DesktopPairingState) {
    const safeState: DesktopPairingState = {
      pairings: sortRecords(state.pairings)
        .map(normalizeRecord)
        .filter((entry): entry is DesktopPairingRecord => Boolean(entry)),
      audit: state.audit
        .map(normalizeAuditEvent)
        .filter((entry): entry is DesktopPairingAuditEvent => Boolean(entry))
        .slice(-MAX_AUDIT_EVENTS),
    }
    writeFileAtomic(this.path, JSON.stringify(safeState, null, 2), { mode: 0o600 })
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
