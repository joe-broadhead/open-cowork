import {
  createCloudProjectionFenceToken,
  type CloudProjectionFenceToken,
} from '@open-cowork/shared'
import type { ServerResponse } from 'node:http'

import type { SessionCommandRecord, SessionEventRecord } from './control-plane-store.ts'
import type { CloudHttpServerOptions } from './http-contracts.ts'
import { readRecord, readString } from './http-request-parsers.ts'
import { writeJson } from './http-response-writers.ts'
import type { CloudPrincipal, CloudSessionView } from './session-service.ts'

export async function processCommandIfConfigured(
  options: CloudHttpServerOptions,
  principal: CloudPrincipal,
  sessionId: string,
) {
  return processSessionCommandIfConfigured(options, principal.tenantId, sessionId)
}

export async function processSessionCommandIfConfigured(
  options: CloudHttpServerOptions,
  tenantId: string,
  sessionId: string,
) {
  if (!options.worker || !options.autoProcessCommands) return 0
  return options.worker.processSessionCommands(tenantId, sessionId)
}

export async function writeSessionCommandMutationResponse(
  res: ServerResponse,
  options: CloudHttpServerOptions,
  principal: CloudPrincipal,
  sessionId: string,
  command: SessionCommandRecord,
  processed: number,
  beforeProjectionSequence: number,
  extraBody: Record<string, unknown> = {},
) {
  const view = await options.service.getSessionView(principal, sessionId)
  const projectionFence = await sessionProjectionFenceForCommand(
    options,
    principal,
    command,
    view,
    processed,
    beforeProjectionSequence,
  )
  writeJson(res, 202, {
    ...extraBody,
    command,
    processed,
    view,
    projectionFence,
  }, options.corsOrigin)
}

export async function currentSessionProjectionSequence(
  options: CloudHttpServerOptions,
  principal: CloudPrincipal,
  sessionId: string,
) {
  const view = await options.service.getSessionView(principal, sessionId)
  return view.projection?.sequence || 0
}

async function sessionProjectionFenceForCommand(
  options: CloudHttpServerOptions,
  principal: CloudPrincipal,
  command: SessionCommandRecord,
  view: CloudSessionView,
  processed: number,
  afterProjectionSequence: number,
): Promise<CloudProjectionFenceToken | null> {
  if (processed <= 0) return null
  const observedSequence = typeof view.projection?.sequence === 'number'
    && Number.isInteger(view.projection.sequence)
    && view.projection.sequence > 0
    ? view.projection.sequence
    : null
  if (observedSequence === null || observedSequence <= afterProjectionSequence) return null
  const events = await options.service.listEvents(principal, command.sessionId, afterProjectionSequence)
  const commandEvent = events.find((event) => (
    event.sequence <= observedSequence
    && sessionEventCommandId(event) === command.commandId
  ))
  if (!commandEvent) return null
  return createCloudProjectionFenceToken({
    scope: 'session',
    tenantId: principal.tenantId,
    sessionId: view.session.sessionId,
    commandId: command.commandId,
    sequence: commandEvent.sequence,
    projectionVersion: commandEvent.sequence,
  })
}

function sessionEventCommandId(event: SessionEventRecord) {
  return readString(readRecord(event.payload)?.commandId)
}
