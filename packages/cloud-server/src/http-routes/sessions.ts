import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  emptySessionImportItemCounts,
  type SessionImportRequest,
} from '@open-cowork/shared'
import { validateCloudArtifactUploadInput } from '../artifact-service.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import type {
  ControlPlaneSessionStatus,
  SessionCommandRecord,
} from '../control-plane-store.ts'
import type {
  CloudHttpServerOptions,
} from '../http-contracts.ts'
import { cloudSessionViewToSessionView } from '../session-view-contract.ts'
import type { CloudPrincipal } from '../session-service.ts'
import { handleSessionArtifactsApiRoute } from './session-artifacts.ts'
import type {
  CloudApiRouteContext,
  CloudApiRouteInput,
  CloudApiRouteTools,
} from './types.ts'

type SessionRouteTools = CloudApiRouteTools & {
  parseSessionStatus(value: string | null): ControlPlaneSessionStatus | null
  handleSessionSse(
    req: IncomingMessage,
    res: ServerResponse,
    options: CloudHttpServerOptions,
    context: CloudApiRouteContext,
    sessionId: string,
  ): Promise<void>
  currentSessionProjectionSequence(
    options: CloudHttpServerOptions,
    principal: CloudPrincipal,
    sessionId: string,
  ): Promise<number>
  processCommandIfConfigured(
    options: CloudHttpServerOptions,
    principal: CloudPrincipal,
    sessionId: string,
  ): Promise<number>
  writeSessionCommandMutationResponse(
    res: ServerResponse,
    options: CloudHttpServerOptions,
    principal: CloudPrincipal,
    sessionId: string,
    command: SessionCommandRecord,
    processed: number,
    beforeProjectionSequence: number,
    extraBody?: Record<string, unknown>,
  ): Promise<void>
}

type SessionRouteInput = Omit<CloudApiRouteInput, 'tools'> & {
  tools: SessionRouteTools
}

const SESSION_IMPORT_MAX_ARTIFACTS = 25

function validatedSessionImportArtifacts(value: unknown): NonNullable<SessionImportRequest['artifacts']> {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new CloudServiceError(400, 'Session import artifacts must be an array.')
  }
  if (value.length > SESSION_IMPORT_MAX_ARTIFACTS) {
    throw new CloudServiceError(400, `Session import accepts no more than ${SESSION_IMPORT_MAX_ARTIFACTS} artifacts.`)
  }
  value.forEach((artifact, index) => {
    try {
      validateCloudArtifactUploadInput(artifact)
    } catch (error) {
      if (error instanceof CloudServiceError) {
        throw new CloudServiceError(error.status, `Session import artifact ${index + 1}: ${error.publicMessage}`)
      }
      throw error
    }
  })
  return value as NonNullable<SessionImportRequest['artifacts']>
}

export async function handleSessionsApiRoute(
  input: SessionRouteInput,
): Promise<boolean> {
  const {
    req,
    res,
    options,
    context,
    resource,
    itemId: sessionId,
    action,
    artifactId,
    tools,
  } = input

  if (resource === 'import') {
    if (sessionId === 'sessions' && !action && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 35 * 1024 * 1024)
      const importRequest = body as SessionImportRequest
      const artifactUploads = validatedSessionImportArtifacts(importRequest.artifacts)
      if (artifactUploads.length > 0 && !options.artifacts) {
        tools.writeError(res, 503, 'Cloud artifact storage is not configured for session import.', options.corsOrigin)
        return true
      }
      let createdSessionId: string | null = null
      try {
        const created = await options.service.createImportedSession(context.principal, {
          ...importRequest,
          artifacts: [],
        })
        createdSessionId = created.session.sessionId
        for (const artifact of artifactUploads) {
          await options.artifacts!.uploadSessionArtifact(context.principal, createdSessionId, {
            filename: artifact.filename,
            contentType: artifact.contentType || null,
            dataBase64: artifact.dataBase64,
            kind: artifact.kind || null,
            status: artifact.status || null,
            authorAgentId: artifact.authorAgentId || null,
            projectId: artifact.projectId || null,
            taskId: artifact.taskId || null,
            statusUpdatedBy: artifact.statusUpdatedBy || null,
            statusUpdatedAt: artifact.statusUpdatedAt || null,
          })
        }
        const itemCounts = emptySessionImportItemCounts({
          ...(importRequest.itemCounts || {}),
          artifacts: artifactUploads.length,
        })
        await options.service.completeSessionImport(context.principal, createdSessionId, {
          sourceFingerprint: importRequest.source?.fingerprint || '',
          itemCounts,
        })
        tools.writeJson(res, 201, await options.service.getSessionView(context.principal, createdSessionId), options.corsOrigin)
      } catch (error) {
        if (createdSessionId) {
          await options.service.recordImportFailed(context.principal, {
            sessionId: createdSessionId,
            sourceFingerprint: importRequest.source?.fingerprint || '',
            itemCounts: importRequest.itemCounts,
            error,
          }).catch(() => undefined)
        }
        throw error
      }
      return true
    }
    tools.writeError(res, 404, 'Not found.', options.corsOrigin)
    return true
  }

  if (resource !== 'sessions') return false

  if (!sessionId && req.method === 'GET') {
    const page = await options.service.listSessionsPage(context.principal, {
      limit: tools.parseLimit(context.url),
      cursor: context.url.searchParams.get('cursor'),
      status: tools.parseSessionStatus(context.url.searchParams.get('status')),
      profileName: context.url.searchParams.get('profileName'),
      query: context.url.searchParams.get('q') || context.url.searchParams.get('query'),
    })
    tools.writeJson(res, 200, {
      sessions: page.items,
      nextCursor: page.nextCursor,
      totalEstimate: page.totalEstimate,
    }, options.corsOrigin)
    return true
  }

  if (!sessionId && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const created = await options.service.createSession(context.principal, {
      profileName: tools.readString(body.profileName),
      projectSource: tools.readOptionalCloudProjectSource(body),
    })
    tools.writeJson(res, 201, created, options.corsOrigin)
    return true
  }

  if (!sessionId) {
    tools.writeError(res, 405, 'Method not allowed.', options.corsOrigin)
    return true
  }

  if (!action && req.method === 'GET') {
    tools.writeJson(res, 200, await options.service.getSessionView(context.principal, sessionId), options.corsOrigin)
    return true
  }

  if (action === 'activate' && req.method === 'POST') {
    tools.writeJson(res, 200, await options.service.getSessionView(context.principal, sessionId), options.corsOrigin)
    return true
  }

  if (action === 'view' && req.method === 'GET') {
    const cloudView = await options.service.getSessionView(context.principal, sessionId)
    tools.writeJson(res, 200, {
      session: cloudView.session,
      projection: cloudView.projection,
      view: cloudSessionViewToSessionView(cloudView),
    }, options.corsOrigin)
    return true
  }

  if (action === 'projection-status' && req.method === 'GET') {
    tools.writeJson(res, 200, await options.service.getSessionProjectionStatus(context.principal, sessionId), options.corsOrigin)
    return true
  }

  if (action === 'projection-repair' && req.method === 'POST') {
    tools.writeJson(res, 200, await options.service.repairSessionProjection(context.principal, sessionId), options.corsOrigin)
    return true
  }

  if (action === 'events' && req.method === 'GET') {
    await tools.handleSessionSse(req, res, options, context, sessionId)
    return true
  }

  if (await handleSessionArtifactsApiRoute({
    req,
    res,
    options,
    context,
    resource,
    itemId: sessionId,
    action,
    artifactId,
    tools,
  })) return true

  if (action === 'prompt' && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const text = tools.readString(body.text)
    if (!text) {
      tools.writeError(res, 400, 'Prompt text is required.', options.corsOrigin)
      return true
    }
    const beforeProjectionSequence = await tools.currentSessionProjectionSequence(options, context.principal, sessionId)
    const command = await options.service.enqueuePrompt(context.principal, sessionId, {
      text,
      agent: tools.readString(body.agent),
    })
    const processed = await tools.processCommandIfConfigured(options, context.principal, sessionId)
    await tools.writeSessionCommandMutationResponse(res, options, context.principal, sessionId, command, processed, beforeProjectionSequence)
    return true
  }

  if (action === 'abort' && req.method === 'POST') {
    const beforeProjectionSequence = await tools.currentSessionProjectionSequence(options, context.principal, sessionId)
    const command = await options.service.enqueueAbort(context.principal, sessionId)
    const processed = await tools.processCommandIfConfigured(options, context.principal, sessionId)
    await tools.writeSessionCommandMutationResponse(res, options, context.principal, sessionId, command, processed, beforeProjectionSequence)
    return true
  }

  if (action === 'question-reply' && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const requestId = tools.readString(body.requestId)
    if (!requestId || !Array.isArray(body.answers)) {
      tools.writeError(res, 400, 'Question reply requires requestId and answers.', options.corsOrigin)
      return true
    }
    const command = await options.service.enqueueQuestionReply(context.principal, sessionId, {
      requestId,
      answers: body.answers,
    })
    const beforeProjectionSequence = await tools.currentSessionProjectionSequence(options, context.principal, sessionId)
    const processed = await tools.processCommandIfConfigured(options, context.principal, sessionId)
    await tools.writeSessionCommandMutationResponse(res, options, context.principal, sessionId, command, processed, beforeProjectionSequence)
    return true
  }

  if (action === 'question-reject' && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const requestId = tools.readString(body.requestId)
    if (!requestId) {
      tools.writeError(res, 400, 'Question rejection requires requestId.', options.corsOrigin)
      return true
    }
    const command = await options.service.enqueueQuestionReject(context.principal, sessionId, {
      requestId,
    })
    const beforeProjectionSequence = await tools.currentSessionProjectionSequence(options, context.principal, sessionId)
    const processed = await tools.processCommandIfConfigured(options, context.principal, sessionId)
    await tools.writeSessionCommandMutationResponse(res, options, context.principal, sessionId, command, processed, beforeProjectionSequence)
    return true
  }

  if (action === 'permission-respond' && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const permissionId = tools.readString(body.permissionId)
    if (!permissionId) {
      tools.writeError(res, 400, 'Permission response requires permissionId.', options.corsOrigin)
      return true
    }
    const command = await options.service.enqueuePermissionResponse(context.principal, sessionId, {
      permissionId,
      response: body.response ?? null,
    })
    const beforeProjectionSequence = await tools.currentSessionProjectionSequence(options, context.principal, sessionId)
    const processed = await tools.processCommandIfConfigured(options, context.principal, sessionId)
    await tools.writeSessionCommandMutationResponse(res, options, context.principal, sessionId, command, processed, beforeProjectionSequence)
    return true
  }

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)

  return true
}
