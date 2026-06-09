import type { ArtifactKind, ArtifactStatus } from './artifacts.js'
import type { MessageAttachment, SessionTokens, TodoItem } from './session.js'

export type SessionImportWarningSeverity = 'info' | 'warning' | 'error'

export type SessionImportWarning = {
  code: string
  message: string
  severity: SessionImportWarningSeverity
}

export type SessionImportExcludedItem = {
  kind: string
  count: number
  reason: string
}

export type SessionImportItemCounts = {
  messages: number
  artifacts: number
  attachments: number
  projectSource: number
  excluded: number
}

export type LocalSessionImportSource = {
  kind: 'local-session'
  fingerprint: string
  title: string
}

export type SessionImportSelection = {
  includeMessages?: boolean
  includeArtifacts?: boolean
  includeAttachments?: boolean
  includeProjectSource?: boolean
  artifactIds?: string[]
  attachmentIds?: string[]
}

export type SessionImportInventory = {
  source: LocalSessionImportSource
  title: string
  counts: SessionImportItemCounts
  defaults: Required<Pick<SessionImportSelection, 'includeMessages' | 'includeArtifacts' | 'includeAttachments' | 'includeProjectSource'>>
  warnings: SessionImportWarning[]
  excluded: SessionImportExcludedItem[]
}

export type SessionImportPortableMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp?: string | null
  order: number
  attachments?: MessageAttachment[]
}

export type SessionImportPortableArtifact = {
  id: string
  filename: string
  contentType?: string | null
  dataBase64: string
  order: number
  toolId?: string | null
  toolName?: string | null
  kind?: ArtifactKind | null
  status?: ArtifactStatus | null
  authorAgentId?: string | null
  projectId?: string | null
  taskId?: string | null
  statusUpdatedBy?: string | null
  statusUpdatedAt?: string | null
}

export type SessionImportRequest = {
  source: LocalSessionImportSource
  title: string
  profileName?: string | null
  selection: SessionImportSelection
  itemCounts: SessionImportItemCounts
  warnings?: SessionImportWarning[]
  excluded?: SessionImportExcludedItem[]
  messages?: SessionImportPortableMessage[]
  artifacts?: SessionImportPortableArtifact[]
  todos?: TodoItem[]
  sessionCost?: number
  sessionTokens?: SessionTokens
}

export type SessionImportResult = {
  workspaceId: string
  sessionId: string
  title: string
  importedAt: string
  itemCounts: SessionImportItemCounts
}

const LOCAL_PATH_PLACEHOLDER = '[local path redacted]'
const SECRET_PLACEHOLDER = '[secret redacted]'

const FILE_URL_RE = /file:\/\/\/[^\s"'<>)]*/gi
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\(?:[^\\\s"'<>|?*]+\\?)+/g
const POSIX_PATH_RE = /(^|[\s"'(])\/(?:Users|home|var|tmp|private|Volumes|workspace|workspaces|srv|opt|etc|mnt)\/[^\s"'<>)]*/g
const SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}|(?:api|access|refresh|secret|token)[_-]?key\s*[:=]\s*[^\s"'<>]{8,})\b/gi

export function redactSessionImportText(value: string) {
  return value
    .replace(FILE_URL_RE, LOCAL_PATH_PLACEHOLDER)
    .replace(WINDOWS_PATH_RE, LOCAL_PATH_PLACEHOLDER)
    .replace(POSIX_PATH_RE, (_match, prefix: string) => `${prefix}${LOCAL_PATH_PLACEHOLDER}`)
    .replace(SECRET_RE, SECRET_PLACEHOLDER)
}

export function containsUnsafeSessionImportText(value: string) {
  return redactSessionImportText(value) !== value
}

export function assertSafeSessionImportPayload(input: unknown) {
  const serialized = JSON.stringify(input) || ''
  if (containsUnsafeSessionImportText(serialized)) {
    throw new Error('Session import payload contains local paths or secret-like values.')
  }
}

export function emptySessionImportItemCounts(overrides: Partial<SessionImportItemCounts> = {}): SessionImportItemCounts {
  return {
    messages: 0,
    artifacts: 0,
    attachments: 0,
    projectSource: 0,
    excluded: 0,
    ...overrides,
  }
}
