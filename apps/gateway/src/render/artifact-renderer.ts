import type {
  ChannelProvider,
  ChannelTarget,
} from '@open-cowork/gateway-channel'
import type {
  ChannelSessionBindingRecord,
  CloudTransportSessionEvent,
} from '@open-cowork/cloud-client'

import type { CloudGateway } from '../cloud-gateway.js'
import {
  executeRenderOperation,
  normalizeChannelCapabilities,
} from './operations.js'
import { sanitizeChannelText } from './sanitize.js'
import { setRenderStateEntry, type GatewaySessionRenderState } from './state.js'

export type RenderArtifactInput = {
  cloud: CloudGateway
  provider: ChannelProvider
  target: ChannelTarget
  binding: ChannelSessionBindingRecord
  event: CloudTransportSessionEvent
  state: GatewaySessionRenderState
}

export type RenderArtifactResult = {
  handled: boolean
  lastChatMessageId?: string | null
}

export async function renderArtifactCreated(input: RenderArtifactInput): Promise<RenderArtifactResult> {
  const artifact = readArtifact(input.event)
  if (!artifact.artifactId) return { handled: false }

  const existing = input.state.artifacts.get(artifact.artifactId)
  if (existing && existing.renderedSequence >= input.event.sequence) {
    return { handled: false, lastChatMessageId: existing.providerMessageId }
  }

  const capabilities = normalizeChannelCapabilities(input.provider.capabilities)
  if (capabilities.fileDownloads && artifact.size <= capabilities.maxFileBytes && input.cloud.readArtifactAttachment) {
    const attachment = await input.cloud.readArtifactAttachment(input.binding.sessionId, artifact.artifactId)
    const file = dataUrlToFile(attachment.url, attachment.filename || artifact.filename, attachment.mime || artifact.mime)
    if (file.data.byteLength <= capabilities.maxFileBytes) {
      const result = await executeRenderOperation(input.provider, {
        type: 'send_file',
        target: input.target,
        file,
      })
      const providerMessageId = result.sentMessage?.messageId ?? existing?.providerMessageId ?? null
      setRenderStateEntry(input.state.artifacts, artifact.artifactId, {
        artifactId: artifact.artifactId,
        providerMessageId,
        renderedSequence: input.event.sequence,
      })
      return { handled: true, lastChatMessageId: providerMessageId }
    }
  }

  const result = await executeRenderOperation(input.provider, {
    type: 'send_artifact_link',
    target: input.target,
    artifact: {
      filename: artifact.filename,
      label: artifact.label,
      url: input.cloud.artifactUrl(input.binding.sessionId, artifact.artifactId),
    },
  })
  const providerMessageId = result.sentMessage?.messageId ?? existing?.providerMessageId ?? null
  setRenderStateEntry(input.state.artifacts, artifact.artifactId, {
    artifactId: artifact.artifactId,
    providerMessageId,
    renderedSequence: input.event.sequence,
  })
  return { handled: true, lastChatMessageId: providerMessageId }
}

export async function renderArtifactUpdated(input: RenderArtifactInput): Promise<RenderArtifactResult> {
  const artifact = readArtifact(input.event)
  if (!artifact.artifactId) return { handled: false }

  const existing = input.state.artifacts.get(artifact.artifactId)
  if (existing && existing.renderedSequence >= input.event.sequence) {
    return { handled: false, lastChatMessageId: existing.providerMessageId }
  }

  const result = await executeRenderOperation(input.provider, {
    type: 'send_artifact_link',
    target: input.target,
    artifact: {
      filename: artifact.filename,
      label: artifactUpdateLabel(artifact),
      url: input.cloud.artifactUrl(input.binding.sessionId, artifact.artifactId),
    },
  })
  const providerMessageId = result.sentMessage?.messageId ?? existing?.providerMessageId ?? null
  setRenderStateEntry(input.state.artifacts, artifact.artifactId, {
    artifactId: artifact.artifactId,
    providerMessageId,
    renderedSequence: input.event.sequence,
  })
  return { handled: true, lastChatMessageId: providerMessageId }
}

function readArtifact(event: CloudTransportSessionEvent) {
  const artifactId = stringField(event.payload, 'artifactId')
    || stringField(event.payload, 'cloudArtifactId')
    || stringField(event.payload, 'id')
    || artifactIdFromFilePath(stringField(event.payload, 'filePath'))
    || event.entityId
    || ''
  const filename = safeFilename(stringField(event.payload, 'filename')) || 'artifact'
  return {
    artifactId,
    filename,
    label: sanitizeChannelText(filename, 160),
    mime: stringField(event.payload, 'contentType') || stringField(event.payload, 'mime') || 'application/octet-stream',
    size: numberField(event.payload, 'size'),
    status: stringField(event.payload, 'status'),
  }
}

function artifactUpdateLabel(artifact: { filename: string, status: string | null }) {
  const status = artifact.status ? ` (${artifact.status})` : ''
  return sanitizeChannelText(`Artifact updated: ${artifact.filename}${status}`, 180)
}

function dataUrlToFile(url: string, filename: string, mime?: string) {
  const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=_-]+)$/i.exec(url)
  if (!match) throw new Error('Cloud artifact attachment did not include a base64 data URL.')
  const data = Buffer.from(match[2] || '', 'base64')
  if (data.byteLength === 0) throw new Error('Cloud artifact attachment is empty.')
  return {
    filename: safeFilename(filename) || 'artifact',
    mimeType: match[1] || mime || 'application/octet-stream',
    data,
  }
}

function artifactIdFromFilePath(filePath: string | null) {
  if (!filePath?.startsWith('cloud-artifact://')) return null
  const [encoded] = filePath.slice('cloud-artifact://'.length).split('/')
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function safeFilename(value: string | null) {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') return null
  return sanitizeChannelText(trimmed.replace(/[\\/:\0]/g, '-'), 180)
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberField(payload: Record<string, unknown>, key: string): number {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
