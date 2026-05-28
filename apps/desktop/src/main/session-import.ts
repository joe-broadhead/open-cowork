import { createHash } from 'node:crypto'
import type {
  MessageAttachment,
  SessionArtifact,
  SessionImportInventory,
  SessionImportPortableArtifact,
  SessionImportPortableMessage,
  SessionImportRequest,
  SessionImportSelection,
  SessionView,
} from '@open-cowork/shared'
import {
  assertSafeSessionImportPayload,
  containsUnsafeSessionImportText,
  emptySessionImportItemCounts,
  redactSessionImportText,
} from '@open-cowork/shared'
import type { SessionRecord } from './session-registry.ts'

export type SessionImportArtifactLoader = (artifact: SessionArtifact) => Promise<{
  dataBase64: string
  contentType?: string | null
} | null>

function sourceFingerprint(sessionId: string) {
  return `sha256:${createHash('sha256').update(`local-session\0${sessionId}`).digest('hex').slice(0, 32)}`
}

function safeTitle(record: SessionRecord) {
  return redactSessionImportText(record.title?.trim() || 'Imported local thread')
}

function importableMessages(view: SessionView): SessionImportPortableMessage[] {
  return view.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .sort((left, right) => left.order - right.order)
    .map((message, index) => ({
      id: `imported:${message.id || index}`,
      role: message.role,
      content: redactSessionImportText(message.content || ''),
      timestamp: message.timestamp || null,
      order: index + 1,
    }))
}

function attachmentAllowed(attachment: MessageAttachment) {
  return /^data:[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127};base64,/i.test(attachment.url)
}

function safeFilename(value: string | undefined, fallback = 'attachment') {
  const basename = (value || '').trim().split(/[\\/]/).filter(Boolean).pop() || fallback
  const redacted = redactSessionImportText(basename).trim()
  return redacted.replace(/[^\w .-]+/g, '-').slice(0, 128) || fallback
}

function importableAttachments(view: SessionView) {
  const attachments: Array<{ messageId: string, attachment: MessageAttachment }> = []
  for (const message of view.messages) {
    for (const attachment of message.attachments || []) {
      if (!attachmentAllowed(attachment)) continue
      attachments.push({
        messageId: message.id,
        attachment: {
          mime: attachment.mime,
          url: attachment.url,
          filename: safeFilename(attachment.filename),
        },
      })
    }
  }
  return attachments
}

function candidateArtifacts(view: SessionView) {
  return (view.artifacts || [])
    .filter((artifact) => artifact.source !== 'cloud' && artifact.id && artifact.filePath && artifact.filename)
}

function redactionWarning(record: SessionRecord, view: SessionView) {
  const serialized = JSON.stringify({
    title: record.title,
    directory: record.directory,
    opencodeDirectory: record.opencodeDirectory,
    messages: view.messages.map((message) => ({
      content: message.content,
      attachments: message.attachments,
    })),
    artifacts: (view.artifacts || []).map((artifact) => ({
      filename: artifact.filename,
      filePath: artifact.filePath,
      toolName: artifact.toolName,
    })),
  })
  return containsUnsafeSessionImportText(serialized)
}

export function buildSessionImportInventory(record: SessionRecord, view: SessionView): SessionImportInventory {
  const messages = importableMessages(view)
  const attachments = importableAttachments(view)
  const artifacts = candidateArtifacts(view)
  const hasProjectSource = Boolean(record.directory || record.opencodeDirectory)
  const excluded = [
    {
      kind: 'secrets',
      count: 1,
      reason: 'Provider keys, OAuth tokens, MCP secrets, and machine runtime credentials are never copied.',
    },
    ...(hasProjectSource
      ? [{
          kind: 'projectSource',
          count: 1,
          reason: 'Project source is not copied by default; cloud workspaces need explicit portable uploads.',
        }]
      : []),
    ...(view.toolCalls.length || view.taskRuns.length
      ? [{
          kind: 'runtimeInternals',
          count: view.toolCalls.length + view.taskRuns.length,
          reason: 'Tool inputs, host paths, stdio MCP commands, and OpenCode runtime internals stay local.',
        }]
      : []),
  ]
  const warnings = [
    ...(redactionWarning(record, view)
      ? [{
          code: 'redacted-local-data',
          message: 'Some local paths or secret-like text will be redacted before cloud import.',
          severity: 'warning' as const,
        }]
      : []),
    ...(artifacts.length
      ? [{
          code: 'artifact-upload-explicit',
          message: 'Artifacts are copied only when selected and must be stored in the cloud object store.',
          severity: 'info' as const,
        }]
      : []),
    ...(hasProjectSource
      ? [{
          code: 'project-source-excluded',
          message: 'Local project source and host paths are excluded in this v1 copy flow.',
          severity: 'info' as const,
        }]
      : []),
  ]
  return {
    source: {
      kind: 'local-session',
      fingerprint: sourceFingerprint(record.id),
      title: safeTitle(record),
    },
    title: safeTitle(record),
    counts: {
      messages: messages.length,
      artifacts: artifacts.length,
      attachments: attachments.length,
      projectSource: hasProjectSource ? 1 : 0,
      excluded: excluded.reduce((sum, item) => sum + item.count, 0),
    },
    defaults: {
      includeMessages: true,
      includeArtifacts: false,
      includeAttachments: false,
      includeProjectSource: false,
    },
    warnings,
    excluded,
  }
}

function selectedArtifacts(view: SessionView, selection: SessionImportSelection) {
  const candidates = candidateArtifacts(view)
  if (!selection.includeArtifacts) return []
  const allowedIds = new Set(selection.artifactIds || [])
  return allowedIds.size > 0 ? candidates.filter((artifact) => allowedIds.has(artifact.id)) : candidates
}

function messagesWithSelectedAttachments(
  view: SessionView,
  messages: SessionImportPortableMessage[],
  selection: SessionImportSelection,
): SessionImportPortableMessage[] {
  if (!selection.includeAttachments) return messages
  const selectedIds = new Set(selection.attachmentIds || [])
  return messages.map((message) => {
    const sourceMessage = view.messages.find((entry) => `imported:${entry.id}` === message.id)
    const attachments = (sourceMessage?.attachments || [])
      .filter(attachmentAllowed)
      .filter((attachment, index) => selectedIds.size === 0 || selectedIds.has(`${sourceMessage?.id || message.id}:${index}`))
      .map((attachment) => ({
        mime: attachment.mime,
        url: attachment.url,
        filename: safeFilename(attachment.filename),
      }))
    return attachments.length > 0 ? { ...message, attachments } : message
  })
}

export async function buildSessionImportRequest(
  record: SessionRecord,
  view: SessionView,
  selection: SessionImportSelection = {},
  loadArtifact?: SessionImportArtifactLoader,
): Promise<SessionImportRequest> {
  const inventory = buildSessionImportInventory(record, view)
  const includeMessages = selection.includeMessages ?? inventory.defaults.includeMessages
  const includeAttachments = selection.includeAttachments ?? inventory.defaults.includeAttachments
  const includeArtifacts = selection.includeArtifacts ?? inventory.defaults.includeArtifacts
  const includeProjectSource = false
  const baseMessages = includeMessages ? importableMessages(view) : []
  const messages = messagesWithSelectedAttachments(view, baseMessages, {
    ...selection,
    includeAttachments,
  })
  const artifacts: SessionImportPortableArtifact[] = []
  if (includeArtifacts && loadArtifact) {
    for (const artifact of selectedArtifacts(view, { ...selection, includeArtifacts })) {
      const loaded = await loadArtifact(artifact)
      if (!loaded) continue
      artifacts.push({
        id: artifact.id,
        filename: safeFilename(artifact.filename, 'artifact'),
        contentType: loaded.contentType || artifact.mime || null,
        dataBase64: loaded.dataBase64,
        order: artifact.order,
        toolId: artifact.toolId || null,
        toolName: artifact.toolName || null,
      })
    }
  }
  const itemCounts = emptySessionImportItemCounts({
    messages: messages.length,
    attachments: messages.reduce((sum, message) => sum + (message.attachments?.length || 0), 0),
    artifacts: artifacts.length,
    projectSource: includeProjectSource ? 1 : 0,
    excluded: inventory.counts.excluded,
  })
  const request: SessionImportRequest = {
    source: inventory.source,
    title: inventory.title,
    selection: {
      ...selection,
      includeMessages,
      includeAttachments,
      includeArtifacts,
      includeProjectSource,
    },
    itemCounts,
    warnings: inventory.warnings,
    excluded: inventory.excluded,
    messages,
    artifacts,
    todos: view.todos.map((todo) => ({
      ...todo,
      content: redactSessionImportText(todo.content),
    })),
    sessionCost: view.sessionCost,
    sessionTokens: view.sessionTokens,
  }
  assertSafeSessionImportPayload(request)
  return request
}
