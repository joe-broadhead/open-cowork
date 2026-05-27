import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WorkflowDraft, WorkflowStatus, WorkflowTriggerType } from '@open-cowork/shared'
import type { CloudArtifactService } from './artifact-service.ts'
import { cloudBrowserAppHtml } from './browser-app.ts'
import type { CloudPrincipal, CloudSessionService, CloudWorker } from './session-service.ts'
import type { CloudRuntimePolicy } from './cloud-config.ts'
import type { CloudObservabilityAdapter } from './observability.ts'
import { recordCloudHttpRequest } from './observability.ts'
import type { CloudCookieSession, CloudSessionCookieManager } from './session-cookie-auth.ts'
import {
  InMemoryWorkflowWebhookSecurityStore,
  WebhookHttpError,
  type WorkflowWebhookAuth,
  type WorkflowWebhookSecurityStore,
} from '../workflow/workflow-webhook-server.ts'

export type CloudAuthResolver = (req: IncomingMessage) => Promise<CloudPrincipal> | CloudPrincipal

export type CloudBrowserAuthRedirect = {
  location: string
  setCookieHeaders?: string[]
}

export type CloudBrowserAuthCallback = {
  principal: CloudPrincipal
  redirectTo: string
  setCookieHeaders?: string[]
}

export type CloudBrowserAuthProvider = {
  isCallbackPath(pathname: string): boolean
  login(req: IncomingMessage, url: URL): Promise<CloudBrowserAuthRedirect> | CloudBrowserAuthRedirect
  callback(req: IncomingMessage, url: URL): Promise<CloudBrowserAuthCallback> | CloudBrowserAuthCallback
}

export type CloudHttpServerOptions = {
  service: CloudSessionService
  artifacts?: CloudArtifactService | null
  policy: CloudRuntimePolicy
  auth?: CloudAuthResolver
  browserAuth?: CloudBrowserAuthProvider | null
  worker?: CloudWorker | null
  webhookSecurity?: WorkflowWebhookSecurityStore | null
  sessionCookies?: CloudSessionCookieManager | null
  observability?: CloudObservabilityAdapter | null
  autoProcessCommands?: boolean
  corsOrigin?: string | null
  maxBodyBytes?: number
  ssePollMs?: number
}

export class CloudHttpError extends Error {
  readonly status: number
  readonly publicMessage: string

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.publicMessage = message
  }
}

type RouteContext = {
  principal: CloudPrincipal
  authSource: 'cookie' | 'resolver'
  cookieSession: CloudCookieSession | null
  url: URL
  segments: string[]
}

const DEFAULT_PRINCIPAL: CloudPrincipal = {
  tenantId: 'default',
  tenantName: 'Default',
  userId: 'local-user',
  email: 'local@example.test',
}

const CLOUD_WEBHOOK_REQUEST_WINDOW_MS = 60 * 1000
const CLOUD_WEBHOOK_REQUEST_LIMIT = 120
const CLOUD_WEBHOOK_AUTH_FAILURE_WINDOW_MS = 60 * 1000
const CLOUD_WEBHOOK_AUTH_FAILURE_LIMIT = 5
const CLOUD_WEBHOOK_AUTH_BACKOFF_MS = 60 * 1000

function defaultAuthResolver(): CloudPrincipal {
  return DEFAULT_PRINCIPAL
}

function writeCorsHeaders(res: ServerResponse, origin: string | null | undefined) {
  if (!origin) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
}

function writeJson(res: ServerResponse, status: number, body: unknown, origin?: string | null) {
  writeCorsHeaders(res, origin)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function writeHtml(res: ServerResponse, status: number, body: string, origin?: string | null) {
  writeCorsHeaders(res, origin)
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
  })
  res.end(body)
}

function writeError(res: ServerResponse, status: number, message: string, origin?: string | null) {
  writeJson(res, status, { error: message }, origin)
}

function writeRedirect(
  res: ServerResponse,
  location: string,
  setCookieHeaders: string[] | undefined,
  origin?: string | null,
) {
  writeCorsHeaders(res, origin)
  if (setCookieHeaders?.length) res.setHeader('Set-Cookie', setCookieHeaders)
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
  })
  res.end()
}

function methodRequiresCsrf(method: string | undefined) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

async function readJsonBodyWithRaw(req: IncomingMessage, maxBodyBytes: number) {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maxBodyBytes) throw new CloudHttpError(413, 'Request body is too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return { body: {}, rawBody: '' }
  const rawBody = Buffer.concat(chunks).toString('utf8')
  const text = rawBody.trim()
  if (!text) return { body: {}, rawBody }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new CloudHttpError(400, 'Request body must be valid JSON.')
  }
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  return { body, rawBody }
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number) {
  return (await readJsonBodyWithRaw(req, maxBodyBytes)).body
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function readStringArray(value: unknown) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null
}

function readRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseSequenceValue(raw: string | null | undefined) {
  if (!raw) return 0
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

function parseAfterSequence(req: IncomingMessage, url: URL) {
  const fromQuery = parseSequenceValue(url.searchParams.get('after'))
  if (fromQuery > 0) return fromQuery
  return parseSequenceValue(firstHeader(req.headers['last-event-id']).trim())
}

function parseLimit(url: URL) {
  const raw = url.searchParams.get('limit')
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parseTagIds(url: URL) {
  const repeated = url.searchParams.getAll('tagId')
  const csv = url.searchParams.get('tagIds')?.split(',') || []
  const values = [...repeated, ...csv].map((value) => value.trim()).filter(Boolean)
  return values.length > 0 ? values : undefined
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || ''
}

function workflowScopeKey(workflowId: string) {
  return createHash('sha256').update(workflowId || 'unknown-workflow').digest('hex').slice(0, 16)
}

function webhookSource(req: IncomingMessage) {
  return req.socket.remoteAddress || 'unknown'
}

function webhookAuthScope(source: string, workflowId: string) {
  return `${source}:${workflowScopeKey(workflowId)}`
}

function extractSignatureWebhookAuth(req: IncomingMessage, rawBody: string): WorkflowWebhookAuth {
  const timestamp = firstHeader(req.headers['x-open-cowork-timestamp']).trim()
  const signature = firstHeader(req.headers['x-open-cowork-signature']).trim()
  if (!timestamp || !signature) {
    throw new WebhookHttpError(401, 'Workflow webhook signature authorization is required.')
  }
  return { kind: 'signature', timestamp, signature, rawBody }
}

function writeSseEvent(res: ServerResponse, event: { sequence: number, type: string, eventId: string, payload: Record<string, unknown> }) {
  res.write(`id: ${event.sequence}\n`)
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function ssePollMs(options: CloudHttpServerOptions) {
  const value = options.ssePollMs ?? 1000
  return Number.isInteger(value) && value > 0 ? value : 1000
}

async function processCommandIfConfigured(
  options: CloudHttpServerOptions,
  principal: CloudPrincipal,
  sessionId: string,
) {
  return processSessionCommandIfConfigured(options, principal.tenantId, sessionId)
}

async function processSessionCommandIfConfigured(
  options: CloudHttpServerOptions,
  tenantId: string,
  sessionId: string,
) {
  if (!options.worker || !options.autoProcessCommands) return 0
  return options.worker.processSessionCommands(tenantId, sessionId)
}

async function handleCloudWorkflowWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  url: URL,
) {
  const match = url.pathname.match(/^\/webhooks\/workflows\/([^/]+)$/)
  if (!match) {
    writeError(res, 404, 'Webhook not found.', options.corsOrigin)
    return
  }
  if (req.method !== 'POST') {
    writeError(res, 405, 'Method not allowed.', options.corsOrigin)
    return
  }
  if (!options.policy.features.workflows || !options.policy.features.webhooks) {
    writeError(res, 404, 'Webhook not found.', options.corsOrigin)
    return
  }

  const source = webhookSource(req)
  const startedAt = Date.now()
  const workflowId = decodeURIComponent(match[1] || '')
  const scope = webhookAuthScope(source, workflowId)
  const securityStore = options.webhookSecurity || new InMemoryWorkflowWebhookSecurityStore()
  try {
    const requestAccepted = await securityStore.claimRequest({
      source,
      nowMs: startedAt,
      windowMs: CLOUD_WEBHOOK_REQUEST_WINDOW_MS,
      limit: CLOUD_WEBHOOK_REQUEST_LIMIT,
    })
    if (!requestAccepted) throw new WebhookHttpError(429, 'Too many workflow webhook requests. Try again later.')
    const authAccepted = await securityStore.checkAuthBackoff({
      scope,
      nowMs: startedAt,
    })
    if (!authAccepted) throw new WebhookHttpError(429, 'Too many rejected workflow webhook requests. Try again later.')
    const { body, rawBody } = await readJsonBodyWithRaw(req, options.maxBodyBytes || 256 * 1024)
    const auth = extractSignatureWebhookAuth(req, rawBody)
    const started = await options.service.runWorkflowWebhook({
      workflowId,
      auth,
      payload: body,
      securityStore,
      now: new Date(startedAt),
    })
    const processed = await processSessionCommandIfConfigured(options, started.tenantId, started.sessionId)
    writeJson(res, 202, {
      ok: true,
      workflowId,
      runId: started.run.id,
      sessionId: started.sessionId,
      processed,
    }, options.corsOrigin)
  } catch (error) {
    const status = error instanceof WebhookHttpError ? error.status : 400
    const message = error instanceof WebhookHttpError ? error.publicMessage : 'Workflow webhook request failed.'
    if (status === 401) {
      await securityStore.recordAuthFailure({
        scope,
        source,
        nowMs: Date.now(),
        windowMs: CLOUD_WEBHOOK_AUTH_FAILURE_WINDOW_MS,
        limit: CLOUD_WEBHOOK_AUTH_FAILURE_LIMIT,
        backoffMs: CLOUD_WEBHOOK_AUTH_BACKOFF_MS,
      })
    }
    writeError(res, status, message, options.corsOrigin)
  }
}

async function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: RouteContext,
  sessionId: string,
) {
  const afterSequence = parseAfterSequence(req, context.url)
  await options.service.getSessionView(context.principal, sessionId)
  writeCorsHeaders(res, options.corsOrigin)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  let lastSequence = afterSequence
  const writeIfNew = (event: {
    sequence: number
    type: string
    eventId: string
    payload: Record<string, unknown>
  }) => {
    if (event.sequence <= lastSequence) return
    writeSseEvent(res, event)
    lastSequence = event.sequence
  }
  for (const event of await options.service.listEvents(context.principal, sessionId, afterSequence)) {
    writeIfNew(event)
  }
  const unsubscribe = options.service.eventBus.subscribe({
    tenantId: context.principal.tenantId,
    sessionId,
    afterSequence,
  }, (event) => {
    writeIfNew(event)
  })
  let pollActive = false
  const pollTimer = setInterval(() => {
    if (pollActive) return
    pollActive = true
    void options.service.listEvents(context.principal, sessionId, lastSequence)
      .then((events) => {
        for (const event of events) writeIfNew(event)
      })
      .catch(() => {})
      .finally(() => {
        pollActive = false
      })
  }, ssePollMs(options))
  req.on('close', () => {
    clearInterval(pollTimer)
    unsubscribe()
  })
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: RouteContext,
) {
  if (context.authSource === 'cookie' && methodRequiresCsrf(req.method)) {
    try {
      options.sessionCookies?.assertCsrf(req)
    } catch {
      writeError(res, 403, 'Cloud CSRF token is missing or invalid.', options.corsOrigin)
      return
    }
  }

  const [api, resource, sessionId, action] = context.segments
  const artifactId = context.segments[4]
  if (api !== 'api') {
    writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }

  if (resource === 'config' && req.method === 'GET') {
    writeJson(res, 200, {
      role: options.policy.role,
      profileName: options.policy.profileName,
      features: options.policy.features,
      allowedAgents: options.policy.allowedAgents,
      allowedTools: options.policy.allowedTools,
      allowedMcps: options.policy.allowedMcps,
    }, options.corsOrigin)
    return
  }

  if (resource === 'workers' && sessionId === 'heartbeats' && !action && req.method === 'GET') {
    writeJson(res, 200, {
      heartbeats: await options.service.listWorkerHeartbeats(),
    }, options.corsOrigin)
    return
  }

  if (resource === 'runtime' && sessionId === 'status' && !action && req.method === 'GET') {
    writeJson(res, 200, {
      role: options.policy.role,
      profileName: options.policy.profileName,
      canExecute: Boolean(options.worker),
      commandProcessing: options.worker
        ? options.autoProcessCommands
          ? 'inline'
          : 'durable'
        : 'delegated',
      checkpoints: Boolean(options.worker),
      heartbeats: await options.service.listWorkerHeartbeats(),
    }, options.corsOrigin)
    return
  }

  if (resource === 'capabilities') {
    if (!options.policy.features.agents && !options.policy.features.customSkills && !options.policy.features.customMcps) {
      writeError(res, 403, 'Capabilities are disabled for this cloud profile.', options.corsOrigin)
      return
    }
    const collection = sessionId
    const itemId = action
    const itemAction = artifactId
    if (!collection && req.method === 'GET') {
      writeJson(res, 200, await options.service.listCapabilityCatalog(context.principal), options.corsOrigin)
      return
    }
    if (collection === 'tools') {
      if (!itemId && req.method === 'GET') {
        writeJson(res, 200, { tools: await options.service.listCapabilityTools(context.principal) }, options.corsOrigin)
        return
      }
      if (itemId && !itemAction && req.method === 'GET') {
        const tool = await options.service.getCapabilityTool(context.principal, itemId)
        if (!tool) {
          writeError(res, 404, 'Capability tool was not found.', options.corsOrigin)
          return
        }
        writeJson(res, 200, { tool }, options.corsOrigin)
        return
      }
    }
    if (collection === 'skills') {
      if (!itemId && req.method === 'GET') {
        writeJson(res, 200, { skills: await options.service.listCapabilitySkills(context.principal) }, options.corsOrigin)
        return
      }
      if (itemId && !itemAction && req.method === 'GET') {
        const skill = await options.service.getCapabilitySkill(context.principal, itemId)
        if (!skill) {
          writeError(res, 404, 'Capability skill was not found.', options.corsOrigin)
          return
        }
        writeJson(res, 200, { skill }, options.corsOrigin)
        return
      }
      if (itemId && itemAction === 'bundle' && req.method === 'GET') {
        const bundle = await options.service.getCapabilitySkillBundle(context.principal, itemId)
        if (!bundle) {
          writeError(res, 404, 'Capability skill bundle was not found.', options.corsOrigin)
          return
        }
        writeJson(res, 200, { bundle }, options.corsOrigin)
        return
      }
    }
    writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }

  if (resource === 'settings') {
    if (!options.policy.features.settings) {
      writeError(res, 403, 'Settings are disabled for this cloud profile.', options.corsOrigin)
      return
    }
    const settingKey = sessionId ? decodeURIComponent(sessionId) : null
    if (!settingKey && req.method === 'GET') {
      writeJson(res, 200, {
        settings: await options.service.listSettingMetadata(context.principal),
      }, options.corsOrigin)
      return
    }
    if (settingKey && req.method === 'GET') {
      writeJson(res, 200, {
        setting: await options.service.getSettingMetadata(context.principal, settingKey),
      }, options.corsOrigin)
      return
    }
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const keyName = settingKey || readString(body.key)
      const value = readRecord(body.value)
      if (!keyName || !value) {
        writeError(res, 400, 'Setting key and object value are required.', options.corsOrigin)
        return
      }
      writeJson(res, 200, {
        setting: await options.service.setSettingMetadata(context.principal, {
          key: keyName,
          value,
        }),
      }, options.corsOrigin)
      return
    }
    writeError(res, 405, 'Method not allowed.', options.corsOrigin)
    return
  }

  if (resource === 'threads') {
    if (!options.policy.features.threadIndex) {
      writeError(res, 403, 'Thread index is disabled for this cloud profile.', options.corsOrigin)
      return
    }
    const collection = sessionId
    const itemId = action
    const itemAction = artifactId

    if (!collection && req.method === 'GET') {
      writeJson(res, 200, {
        threads: await options.service.listThreadMetadata(context.principal, {
          tagIds: parseTagIds(context.url),
          limit: parseLimit(context.url),
        }),
      }, options.corsOrigin)
      return
    }

    if (collection === 'tags') {
      if (!itemId && req.method === 'GET') {
        writeJson(res, 200, { tags: await options.service.listThreadTags(context.principal) }, options.corsOrigin)
        return
      }
      if (!itemId && req.method === 'POST') {
        const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
        const name = readString(body.name)
        if (!name) {
          writeError(res, 400, 'Tag name is required.', options.corsOrigin)
          return
        }
        const tag = await options.service.createThreadTag(context.principal, {
          name,
          color: readString(body.color),
        })
        writeJson(res, 201, { tag }, options.corsOrigin)
        return
      }
      if (itemId && !itemAction && req.method === 'PATCH') {
        const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
        const tag = await options.service.updateThreadTag(context.principal, itemId, {
          name: body.name === undefined ? undefined : readString(body.name) || '',
          color: body.color === undefined ? undefined : readString(body.color),
        })
        if (!tag) {
          writeError(res, 404, 'Thread tag was not found.', options.corsOrigin)
          return
        }
        writeJson(res, 200, { tag }, options.corsOrigin)
        return
      }
      if (itemId && !itemAction && req.method === 'DELETE') {
        writeJson(res, 200, {
          deleted: await options.service.deleteThreadTag(context.principal, itemId),
        }, options.corsOrigin)
        return
      }
      if (itemId && (itemAction === 'apply' || itemAction === 'remove') && req.method === 'POST') {
        const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
        const sessionIds = readStringArray(body.sessionIds)
        if (!sessionIds) {
          writeError(res, 400, 'sessionIds must be an array of strings.', options.corsOrigin)
          return
        }
        if (itemAction === 'apply') {
          await options.service.applyThreadTag(context.principal, itemId, sessionIds)
        } else {
          await options.service.removeThreadTag(context.principal, itemId, sessionIds)
        }
        writeJson(res, 200, { ok: true }, options.corsOrigin)
        return
      }
    }

    if (collection === 'smart-filters') {
      if (!itemId && req.method === 'GET') {
        writeJson(res, 200, {
          filters: await options.service.listThreadSmartFilters(context.principal),
        }, options.corsOrigin)
        return
      }
      if (!itemId && req.method === 'POST') {
        const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
        const name = readString(body.name)
        const query = readRecord(body.query)
        if (!name || !query) {
          writeError(res, 400, 'Smart filter name and query are required.', options.corsOrigin)
          return
        }
        const filter = await options.service.createThreadSmartFilter(context.principal, { name, query })
        writeJson(res, 201, { filter }, options.corsOrigin)
        return
      }
      if (itemId && !itemAction && req.method === 'PATCH') {
        const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
        const filter = await options.service.updateThreadSmartFilter(context.principal, itemId, {
          name: body.name === undefined ? undefined : readString(body.name) || '',
          query: body.query === undefined ? undefined : readRecord(body.query) || {},
        })
        if (!filter) {
          writeError(res, 404, 'Smart filter was not found.', options.corsOrigin)
          return
        }
        writeJson(res, 200, { filter }, options.corsOrigin)
        return
      }
      if (itemId && !itemAction && req.method === 'DELETE') {
        writeJson(res, 200, {
          deleted: await options.service.deleteThreadSmartFilter(context.principal, itemId),
        }, options.corsOrigin)
        return
      }
    }

    writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }

  if (resource === 'workflows') {
    if (!options.policy.features.workflows) {
      writeError(res, 403, 'Workflows are disabled for this cloud profile.', options.corsOrigin)
      return
    }

    const workflowId = sessionId
    const workflowAction = action

    if (!workflowId && req.method === 'GET') {
      writeJson(res, 200, await options.service.listWorkflows(context.principal), options.corsOrigin)
      return
    }

    if (!workflowId && req.method === 'POST') {
      const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const draft = body as Partial<WorkflowDraft>
      const workflow = await options.service.createWorkflow(context.principal, {
        title: readString(draft.title) || '',
        instructions: readString(draft.instructions) || '',
        agentName: readString(draft.agentName) || 'build',
        skillNames: readStringArray(draft.skillNames) || [],
        toolIds: readStringArray(draft.toolIds) || [],
        projectDirectory: readString(draft.projectDirectory),
        draftSessionId: readString(draft.draftSessionId),
        triggers: Array.isArray(draft.triggers) ? draft.triggers : [],
      })
      writeJson(res, 201, { workflow }, options.corsOrigin)
      return
    }

    if (workflowId === 'scheduler' && workflowAction === 'tick' && req.method === 'POST') {
      const started = await options.service.claimAndStartDueWorkflow()
      const processed = started
        ? await processSessionCommandIfConfigured(options, started.tenantId, started.sessionId)
        : 0
      const workflow = started
        ? await options.service.getWorkflow(context.principal, started.workflow.id).catch(() => null)
        : null
      writeJson(res, 200, {
        claimed: workflow && started
          ? { ...started, workflow, run: workflow.runs.find((run) => run.id === started.run.id) || started.run }
          : started,
        processed,
      }, options.corsOrigin)
      return
    }

    if (!workflowId) {
      writeError(res, 405, 'Method not allowed.', options.corsOrigin)
      return
    }

    if (!workflowAction && req.method === 'GET') {
      const workflow = await options.service.getWorkflow(context.principal, workflowId)
      if (!workflow) {
        writeError(res, 404, 'Workflow was not found.', options.corsOrigin)
        return
      }
      writeJson(res, 200, { workflow }, options.corsOrigin)
      return
    }

    if (workflowAction === 'run' && req.method === 'POST') {
      const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const triggerType = readString(body.triggerType) as WorkflowTriggerType | null
      const started = await options.service.runWorkflow(context.principal, workflowId, {
        triggerType: triggerType || 'manual',
        triggerPayload: readRecord(body.triggerPayload),
      })
      const processed = await processSessionCommandIfConfigured(options, started.tenantId, started.sessionId)
      const workflow = await options.service.getWorkflow(context.principal, workflowId)
      writeJson(res, 202, {
        ...started,
        workflow: workflow || started.workflow,
        run: workflow?.runs.find((run) => run.id === started.run.id) || started.run,
        processed,
      }, options.corsOrigin)
      return
    }

    if ((workflowAction === 'pause' || workflowAction === 'resume' || workflowAction === 'archive') && req.method === 'POST') {
      const status: WorkflowStatus = workflowAction === 'resume'
        ? 'active'
        : workflowAction === 'pause'
          ? 'paused'
          : 'archived'
      const workflow = await options.service.updateWorkflowStatus(context.principal, workflowId, status)
      if (!workflow) {
        writeError(res, 404, 'Workflow was not found.', options.corsOrigin)
        return
      }
      writeJson(res, 200, { workflow }, options.corsOrigin)
      return
    }

    writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }

  if (resource !== 'sessions') {
    writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }

  if (!sessionId && req.method === 'GET') {
    writeJson(res, 200, { sessions: await options.service.listSessions(context.principal) }, options.corsOrigin)
    return
  }

  if (!sessionId && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const created = await options.service.createSession(context.principal, {
      profileName: readString(body.profileName),
    })
    writeJson(res, 201, created, options.corsOrigin)
    return
  }

  if (!sessionId) {
    writeError(res, 405, 'Method not allowed.', options.corsOrigin)
    return
  }

  if (!action && req.method === 'GET') {
    writeJson(res, 200, await options.service.getSessionView(context.principal, sessionId), options.corsOrigin)
    return
  }

  if (action === 'activate' && req.method === 'POST') {
    writeJson(res, 200, await options.service.getSessionView(context.principal, sessionId), options.corsOrigin)
    return
  }

  if (action === 'events' && req.method === 'GET') {
    await handleSse(req, res, options, context, sessionId)
    return
  }

  if (action === 'artifacts') {
    if (!options.policy.features.artifacts) {
      writeError(res, 403, 'Artifacts are disabled for this cloud profile.', options.corsOrigin)
      return
    }
    if (!options.artifacts) {
      writeError(res, 503, 'Cloud artifact storage is not configured.', options.corsOrigin)
      return
    }
    if (!artifactId && req.method === 'GET') {
      writeJson(res, 200, {
        artifacts: await options.artifacts.listSessionArtifacts(context.principal, sessionId),
      }, options.corsOrigin)
      return
    }
    if (!artifactId && req.method === 'POST') {
      const body = await readJsonBody(req, options.maxBodyBytes || 35 * 1024 * 1024)
      const uploaded = await options.artifacts.uploadSessionArtifact(context.principal, sessionId, {
        filename: readString(body.filename) || '',
        contentType: readString(body.contentType),
        dataBase64: readString(body.dataBase64) || '',
      })
      writeJson(res, 201, { artifact: uploaded }, options.corsOrigin)
      return
    }
    if (artifactId && req.method === 'GET') {
      const artifact = await options.artifacts.readSessionArtifact(context.principal, sessionId, artifactId)
      writeJson(res, 200, { artifact }, options.corsOrigin)
      return
    }
  }

  if (action === 'prompt' && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const text = readString(body.text)
    if (!text) {
      writeError(res, 400, 'Prompt text is required.', options.corsOrigin)
      return
    }
    const command = await options.service.enqueuePrompt(context.principal, sessionId, {
      text,
      agent: readString(body.agent),
    })
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    writeJson(res, 202, {
      command,
      processed,
      view: await options.service.getSessionView(context.principal, sessionId),
    }, options.corsOrigin)
    return
  }

  if (action === 'abort' && req.method === 'POST') {
    const command = await options.service.enqueueAbort(context.principal, sessionId)
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    writeJson(res, 202, {
      command,
      processed,
      view: await options.service.getSessionView(context.principal, sessionId),
    }, options.corsOrigin)
    return
  }

  if (action === 'question-reply' && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const requestId = readString(body.requestId)
    if (!requestId || !Array.isArray(body.answers)) {
      writeError(res, 400, 'Question reply requires requestId and answers.', options.corsOrigin)
      return
    }
    const command = await options.service.enqueueQuestionReply(context.principal, sessionId, {
      requestId,
      answers: body.answers,
    })
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    writeJson(res, 202, { command, processed }, options.corsOrigin)
    return
  }

  if (action === 'permission-respond' && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const permissionId = readString(body.permissionId)
    if (!permissionId) {
      writeError(res, 400, 'Permission response requires permissionId.', options.corsOrigin)
      return
    }
    const command = await options.service.enqueuePermissionResponse(context.principal, sessionId, {
      permissionId,
      response: body.response ?? null,
    })
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    writeJson(res, 202, { command, processed }, options.corsOrigin)
    return
  }

  writeError(res, 404, 'Not found.', options.corsOrigin)
}

async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: RouteContext | null,
  auth: CloudAuthResolver,
) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname === '/auth/me' && req.method === 'GET') {
    if (!context) {
      writeError(res, 401, 'Cloud authentication is required.', options.corsOrigin)
      return
    }
    writeJson(res, 200, {
      principal: context.principal,
      csrfToken: context.cookieSession?.csrfToken || null,
      expiresAt: context.cookieSession?.expiresAt || null,
    }, options.corsOrigin)
    return
  }

  if (!options.sessionCookies) {
    writeError(res, 404, 'Cloud browser sessions are not configured.', options.corsOrigin)
    return
  }

  if (url.pathname === '/auth/login' && req.method === 'GET') {
    if (!options.browserAuth) {
      writeError(res, 404, 'Cloud browser OIDC login is not configured.', options.corsOrigin)
      return
    }
    const redirect = await options.browserAuth.login(req, url)
    writeRedirect(res, redirect.location, redirect.setCookieHeaders, options.corsOrigin)
    return
  }

  if (options.browserAuth?.isCallbackPath(url.pathname) && req.method === 'GET') {
    const completed = await options.browserAuth.callback(req, url)
    const issued = options.sessionCookies.issue(completed.principal)
    writeRedirect(res, completed.redirectTo || '/', [
      ...(completed.setCookieHeaders || []),
      ...issued.setCookieHeaders,
    ], options.corsOrigin)
    return
  }

  if (url.pathname === '/auth/session' && req.method === 'POST') {
    const principal = await auth(req)
    const issued = options.sessionCookies.issue(principal)
    res.setHeader('Set-Cookie', issued.setCookieHeaders)
    writeJson(res, 200, {
      principal: issued.principal,
      csrfToken: issued.csrfToken,
      expiresAt: issued.expiresAt,
    }, options.corsOrigin)
    return
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    if (context?.authSource === 'cookie') {
      try {
        options.sessionCookies.assertCsrf(req)
      } catch {
        writeError(res, 403, 'Cloud CSRF token is missing or invalid.', options.corsOrigin)
        return
      }
    }
    res.setHeader('Set-Cookie', options.sessionCookies.clear())
    writeJson(res, 200, { ok: true }, options.corsOrigin)
    return
  }

  writeError(res, 404, 'Not found.', options.corsOrigin)
}

export class CloudHttpServer {
  private readonly server: Server
  private readonly options: CloudHttpServerOptions

  constructor(options: CloudHttpServerOptions) {
    this.options = {
      ...options,
      webhookSecurity: options.webhookSecurity || new InMemoryWorkflowWebhookSecurityStore(),
    }
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  async listen(port = 0, hostname = '127.0.0.1') {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, hostname, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    return this.url()
  }

  url() {
    const address = this.server.address() as AddressInfo | null
    if (!address) throw new Error('Cloud HTTP server is not listening.')
    return `http://${address.address}:${address.port}`
  }

  async close() {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const startedAt = Date.now()
    const requestId = firstHeader(req.headers['x-request-id']).trim() || randomUUID()
    const url = new URL(req.url || '/', 'http://localhost')
    res.setHeader('X-Request-Id', requestId)
    res.on('finish', () => {
      void recordCloudHttpRequest(this.options.observability, {
        requestId,
        method: req.method || 'GET',
        path: url.pathname,
        statusCode: res.statusCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        role: this.options.policy.role,
        profileName: this.options.policy.profileName,
        timestamp: new Date(),
      }).catch(() => {})
    })
    try {
      writeCorsHeaders(res, this.options.corsOrigin)
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
        writeHtml(res, 200, cloudBrowserAppHtml(this.options.policy), this.options.corsOrigin)
        return
      }

      if (url.pathname === '/healthz') {
        writeJson(res, 200, {
          ok: true,
          role: this.options.policy.role,
          profileName: this.options.policy.profileName,
        }, this.options.corsOrigin)
        return
      }

      if (url.pathname.startsWith('/webhooks/workflows/')) {
        await handleCloudWorkflowWebhook(req, res, this.options, url)
        return
      }

      if (url.pathname.startsWith('/auth/') || this.options.browserAuth?.isCallbackPath(url.pathname)) {
        const auth = this.options.auth || defaultAuthResolver
        const cookieSession = this.options.sessionCookies?.read(req) || null
        const principal = cookieSession?.principal || (
          url.pathname === '/auth/me'
            ? await auth(req)
            : null
        )
        const context = principal
          ? {
              principal,
              authSource: cookieSession ? 'cookie' as const : 'resolver' as const,
              cookieSession,
              url,
              segments: url.pathname.split('/').filter(Boolean),
            }
          : null
        await handleAuthRequest(req, res, this.options, context, auth)
        return
      }
      const auth = this.options.auth || defaultAuthResolver
      const cookieSession = this.options.sessionCookies?.read(req) || null
      const principal = cookieSession?.principal || await auth(req)
      const context: RouteContext = {
        principal,
        authSource: cookieSession ? 'cookie' : 'resolver',
        cookieSession,
        url,
        segments: url.pathname.split('/').filter(Boolean),
      }
      const segments = url.pathname.split('/').filter(Boolean)
      await handleApiRequest(req, res, this.options, {
        ...context,
        segments,
      })
    } catch (error) {
      if (error instanceof CloudHttpError) {
        writeError(res, error.status, error.publicMessage, this.options.corsOrigin)
        return
      }
      writeError(res, 500, 'Internal server error.', this.options.corsOrigin)
    }
  }
}

export function createCloudHttpServer(options: CloudHttpServerOptions) {
  return new CloudHttpServer(options)
}
