import type { ServerResponse } from 'node:http'
import type { CloudSessionEventType } from '@open-cowork/shared'
import { readRecord } from './http-request-parsers.ts'

// Pure SSE (server-sent-events) helpers for the cloud HTTP server, extracted from
// http-server.ts: write an SSE frame, redact non-public fields from event
// payloads / channel interactions, and emit the snapshot-required signal. No
// server state beyond the passed response.

export function writeSseEvent(res: ServerResponse, event: {
  tenantId?: string
  userId?: string
  sessionId?: string | null
  sequence: number
  entityType?: string
  entityId?: string
  operation?: string
  projectionVersion?: number
  type: CloudSessionEventType
  eventId: string
  payload: Record<string, unknown>
  createdAt?: string
}) {
  const publicEvent = {
    ...event,
    payload: publicSsePayload(event.type, event.payload),
  }
  res.write(`id: ${event.sequence}\n`)
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(publicEvent)}\n\n`)
}

export function publicSsePayload(type: string, payload: Record<string, unknown>) {
  if (type !== 'artifact.created' && type !== 'artifact.updated') return payload
  const record = { ...payload }
  delete record.key
  return record
}

export function publicChannelInteraction(value: unknown) {
  const record = { ...(readRecord(value) || {}) }
  delete record.tokenHash
  return record
}

export function writeSnapshotRequiredEvent(
  res: ServerResponse,
  afterSequence: number,
  payload: Record<string, unknown>,
) {
  writeSseEvent(res, {
    sequence: afterSequence,
    type: 'snapshot.required',
    eventId: `snapshot-required:${afterSequence}`,
    entityType: 'workspace',
    entityId: 'workspace',
    operation: 'snapshot_required',
    projectionVersion: afterSequence,
    createdAt: new Date().toISOString(),
    payload,
  })
}
