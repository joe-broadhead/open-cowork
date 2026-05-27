import { randomUUID } from 'node:crypto'
import type { ObjectStoreAdapter } from './object-store.ts'
import { artifactObjectKey } from './object-store.ts'
import type { CloudPrincipal, CloudSessionService } from './session-service.ts'

export type CloudArtifactRecord = {
  artifactId: string
  sessionId: string
  filename: string
  contentType: string | null
  size: number
  key: string
  createdAt: string
}

export type CloudArtifactUploadInput = {
  filename: string
  contentType?: string | null
  dataBase64: string
}

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

function boundedFilename(value: unknown) {
  if (typeof value !== 'string') throw new Error('Artifact filename is required.')
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Artifact filename is required.')
  if (trimmed.length > 256 || /[\\/\0]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error('Artifact filename is invalid.')
  }
  return trimmed
}

function boundedContentType(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new Error('Artifact contentType must be a string.')
  const trimmed = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/.test(trimmed)) {
    throw new Error('Artifact contentType is invalid.')
  }
  return trimmed
}

function decodeBase64(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Artifact dataBase64 is required.')
  if (!/^[A-Za-z0-9+/=\s_-]+$/.test(value)) throw new Error('Artifact dataBase64 is invalid.')
  const buffer = Buffer.from(value, value.includes('-') || value.includes('_') ? 'base64url' : 'base64')
  if (buffer.byteLength === 0) throw new Error('Artifact dataBase64 is empty.')
  if (buffer.byteLength > MAX_ARTIFACT_BYTES) throw new Error('Artifact is too large.')
  return buffer
}

function asArtifactRecord(value: unknown): CloudArtifactRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<CloudArtifactRecord>
  if (
    typeof record.artifactId !== 'string'
    || typeof record.sessionId !== 'string'
    || typeof record.filename !== 'string'
    || typeof record.key !== 'string'
    || typeof record.createdAt !== 'string'
    || typeof record.size !== 'number'
  ) {
    return null
  }
  return {
    artifactId: record.artifactId,
    sessionId: record.sessionId,
    filename: record.filename,
    contentType: typeof record.contentType === 'string' ? record.contentType : null,
    size: record.size,
    key: record.key,
    createdAt: record.createdAt,
  }
}

export class CloudArtifactService {
  private readonly sessionService: CloudSessionService
  private readonly objectStore: ObjectStoreAdapter
  private readonly ids: { randomUUID: () => string }

  constructor(
    sessionService: CloudSessionService,
    objectStore: ObjectStoreAdapter,
    ids: { randomUUID: () => string } = { randomUUID },
  ) {
    this.sessionService = sessionService
    this.objectStore = objectStore
    this.ids = ids
  }

  async uploadSessionArtifact(
    principal: CloudPrincipal,
    sessionId: string,
    input: CloudArtifactUploadInput,
  ): Promise<CloudArtifactRecord> {
    await this.sessionService.getSessionView(principal, sessionId)
    const artifactId = this.ids.randomUUID()
    const filename = boundedFilename(input.filename)
    const contentType = boundedContentType(input.contentType)
    const body = decodeBase64(input.dataBase64)
    const key = artifactObjectKey({
      tenantId: principal.tenantId,
      sessionId,
      artifactId,
      filename,
    })
    const stored = await this.objectStore.putObject({
      key,
      body,
      contentType,
      metadata: {
        tenant: principal.tenantId,
        session: sessionId,
        artifact: artifactId,
      },
    })
    const record: CloudArtifactRecord = {
      artifactId,
      sessionId,
      filename,
      contentType,
      size: stored.size,
      key,
      createdAt: new Date().toISOString(),
    }
    await this.sessionService.appendProductEvent(principal, sessionId, {
      type: 'artifact.created',
      payload: record,
    })
    return record
  }

  async listSessionArtifacts(principal: CloudPrincipal, sessionId: string): Promise<CloudArtifactRecord[]> {
    await this.sessionService.getSessionView(principal, sessionId)
    const events = await this.sessionService.listEvents(principal, sessionId)
    return events
      .filter((event) => event.type === 'artifact.created')
      .map((event) => asArtifactRecord(event.payload))
      .filter((record): record is CloudArtifactRecord => Boolean(record))
  }

  async readSessionArtifact(principal: CloudPrincipal, sessionId: string, artifactId: string) {
    const artifact = (await this.listSessionArtifacts(principal, sessionId))
      .find((entry) => entry.artifactId === artifactId)
    if (!artifact) throw new Error(`Unknown artifact ${artifactId}.`)
    const object = await this.objectStore.getObject(artifact.key)
    if (!object) throw new Error(`Artifact object ${artifactId} is missing.`)
    return {
      ...artifact,
      contentType: object.contentType || artifact.contentType,
      dataBase64: object.body.toString('base64'),
    }
  }
}
