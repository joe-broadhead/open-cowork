#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHttpSseCloudTransportAdapter } from '../packages/cloud-client/src/index.ts'
import {
  CloudWorkspaceAdapter,
  cloudWorkspaceCacheKey,
} from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import { FileCloudWorkspaceCache } from '../apps/desktop/src/main/cloud-workspace-cache.ts'
import {
  cloudWorkspaceIdForBaseUrl,
  normalizeCloudWorkspaceBaseUrl,
} from '../apps/desktop/src/main/cloud-workspace-registry.ts'
import {
  LOCAL_WORKSPACE_ID,
  createWorkspaceGateway,
} from '../apps/desktop/src/main/workspace-gateway.ts'

const args = parseArgs(process.argv.slice(2))
const debugEnabled = process.env.OPEN_COWORK_DESKTOP_SMOKE_DEBUG === 'true'

function parseArgs(argv) {
  const parsed = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      parsed.set(key, 'true')
    } else {
      parsed.set(key, next)
      index += 1
    }
  }
  return parsed
}

function argOrEnv(argName, envName, fallback = '') {
  return args.get(argName) || process.env[envName] || fallback
}

function envOrFallback(primary, fallback) {
  return process.env[primary] || process.env[fallback] || ''
}

function boolArg(argName, envName) {
  return args.has(argName) || process.env[envName] === 'true'
}

function intArg(argName, envName, fallback) {
  const raw = args.get(argName) || process.env[envName] || ''
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer.`)
  }
  return parsed
}

function tokenEnv(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim()
    ? process.env[name].trim()
    : ''
}

function debug(message) {
  if (debugEnabled) process.stderr.write(`[desktop-cloud-smoke:debug] ${message}\n`)
}

function requireCloudUrl() {
  const raw = argOrEnv('cloud-url', 'OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL')
    || process.env.OPEN_COWORK_SMOKE_CLOUD_URL
  if (!raw) {
    throw new Error('Set OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL or pass --cloud-url for Desktop cloud sync smoke.')
  }
  return normalizeCloudWorkspaceBaseUrl(raw)
}

function transport(baseUrl, token) {
  return createHttpSseCloudTransportAdapter({
    baseUrl,
    headers: { authorization: `Bearer ${token}` },
  })
}

function encryptedStorage() {
  return {
    mode: 'plaintext',
    encryptString: (plaintext) => Buffer.from(plaintext, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8'),
  }
}

function failingTransport(baseUrl) {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'workspaceEventsUrl') return () => `${baseUrl}/api/events`
      if (prop === 'sessionEventsUrl') return (sessionId) => `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/events`
      if (prop === 'subscribeWorkspaceEvents' || prop === 'subscribeSessionEvents') return () => ({ close() {} })
      return async () => {
        throw new Error('desktop cloud transport offline fixture')
      }
    },
  })
}

function createDesktopAdapter({ baseUrl, token, connection, cache }) {
  return new CloudWorkspaceAdapter({
    connection,
    transport: transport(baseUrl, token),
    cache,
  })
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForEvent(setup, predicate, label, timeoutMs) {
  let subscription = null
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { subscription?.close() } catch { /* ignore close failures */ }
      reject(new Error(`Timed out waiting for ${label}.`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    subscription = setup((event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      try { subscription?.close() } catch { /* ignore close failures */ }
      resolve(event)
    }, (error) => {
      clearTimeout(timer)
      try { subscription?.close() } catch { /* ignore close failures */ }
      reject(error)
    })
  })
}

async function waitForView(getter, predicate, label, timeoutMs) {
  const startedAt = Date.now()
  let latest = null
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await getter()
    if (predicate(latest)) return latest
    await wait(100)
  }
  throw new Error(`Timed out waiting for ${label}. Latest revision: ${latest?.revision ?? 'unknown'}.`)
}

function projectionSequence(view) {
  const projection = view && typeof view === 'object' ? view.projection : null
  const sequence = projection && typeof projection === 'object' ? projection.sequence : null
  return typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : 0
}

function cloudSessionId(view) {
  const session = view && typeof view === 'object' ? view.session : null
  const sessionId = session && typeof session === 'object' ? session.sessionId : null
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('Cloud session response did not include a session id.')
  }
  return sessionId
}

function outputViewShape(view) {
  return {
    revision: view.revision || 0,
    messages: Array.isArray(view.messages) ? view.messages.length : 0,
    taskRuns: Array.isArray(view.taskRuns) ? view.taskRuns.length : 0,
    toolCalls: Array.isArray(view.toolCalls) ? view.toolCalls.length : 0,
    pendingApprovals: Array.isArray(view.pendingApprovals) ? view.pendingApprovals.length : 0,
    pendingQuestions: Array.isArray(view.pendingQuestions) ? view.pendingQuestions.length : 0,
    artifacts: Array.isArray(view.artifacts) ? view.artifacts.length : 0,
    todos: Array.isArray(view.todos) ? view.todos.length : 0,
    errors: Array.isArray(view.errors) ? view.errors.length : 0,
  }
}

async function checkDesktopAuthConfig(baseUrl) {
  if (boolArg('skip-auth-config', 'OPEN_COWORK_DESKTOP_SMOKE_SKIP_AUTH_CONFIG')) return { skipped: true }
  const response = await fetch(`${baseUrl}/auth/desktop/config`)
  const text = await response.text()
  if (!response.ok) {
    if (response.status === 404) {
      return {
        skipped: true,
        reason: 'desktop auth metadata is not configured; continuing with API-token smoke',
      }
    }
    throw new Error(`/auth/desktop/config returned ${response.status}: ${text.slice(0, 240)}`)
  }
  const body = text ? JSON.parse(text) : null
  if (!body || body.mode !== 'oidc' || typeof body.issuerUrl !== 'string' || typeof body.clientId !== 'string') {
    throw new Error('/auth/desktop/config must expose OIDC desktop login metadata.')
  }
  return {
    mode: body.mode,
    issuerConfigured: Boolean(body.issuerUrl),
    clientConfigured: Boolean(body.clientId),
    scopeConfigured: Boolean(body.scope),
  }
}

async function maybeIssueDesktopToken(baseUrl) {
  const adminToken = tokenEnv('OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN')
  const providedDesktopToken = tokenEnv('OPEN_COWORK_DESKTOP_SMOKE_DESKTOP_TOKEN')
    || envOrFallback('OPEN_COWORK_DESKTOP_SMOKE_CLOUD_TOKEN', 'OPEN_COWORK_SMOKE_CLOUD_TOKEN')

  if (!adminToken && !providedDesktopToken) {
    throw new Error('Set OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN for a full ephemeral-token smoke, or OPEN_COWORK_DESKTOP_SMOKE_DESKTOP_TOKEN for an existing desktop token.')
  }
  if (!adminToken) {
    return {
      adminClient: null,
      desktopToken: providedDesktopToken,
      issuedToken: null,
      tokenSource: 'provided',
    }
  }

  const adminClient = transport(baseUrl, adminToken)
  const ttlSeconds = intArg('token-ttl-seconds', 'OPEN_COWORK_DESKTOP_SMOKE_TOKEN_TTL_SECONDS', 15 * 60)
  const issued = await adminClient.issueApiToken({
    name: `Desktop GCP sync smoke ${new Date().toISOString()}`,
    scopes: ['desktop'],
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  })
  return {
    adminClient,
    desktopToken: issued.plaintext,
    issuedToken: issued.token,
    tokenSource: 'ephemeral',
  }
}

function promptViewSucceeded(view) {
  return outputViewShape(view).messages > 0
}

function promptViewErrors(view) {
  return Array.isArray(view?.errors) ? view.errors : []
}

async function waitForSuccessfulPromptView(getter, beforeSequence, label, timeoutMs) {
  return waitForView(
    async () => {
      const view = await getter()
      const errors = promptViewErrors(view)
      if (errors.length > 0) {
        const message = errors
          .map((error) => error?.message)
          .filter(Boolean)
          .join('; ')
        throw new Error(`${label} reported cloud session errors: ${message || 'unknown error'}`)
      }
      return view
    },
    (view) => (view.revision || 0) > beforeSequence && promptViewSucceeded(view),
    `${label} assistant output`,
    timeoutMs,
  )
}

async function revokeAndVerify({ adminClient, baseUrl, issuedToken, desktopToken }) {
  if (!adminClient || !issuedToken) {
    if (boolArg('require-revocation', 'OPEN_COWORK_DESKTOP_SMOKE_REQUIRE_REVOCATION')) {
      throw new Error('Token revocation smoke requires OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN.')
    }
    return { skipped: true }
  }
  const revoked = await adminClient.revokeApiToken(issuedToken.tokenId)
  if (!revoked?.revokedAt) {
    throw new Error('Desktop smoke token was not revoked.')
  }
  const response = await fetch(`${baseUrl}/api/workspace`, {
    headers: { authorization: `Bearer ${desktopToken}` },
  })
  if (response.status === 401 || response.status === 403) {
    return {
      tokenId: issuedToken.tokenId,
      revokedAt: revoked.revokedAt,
      rejected: true,
    }
  }
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Revocation verification returned ${response.status} instead of an auth failure: ${text.slice(0, 240)}`)
  }
  throw new Error('Revoked desktop token was still accepted by the cloud API.')
}

function assertLocalWorkspaceBoundary() {
  const gateway = createWorkspaceGateway({
    cloudDesktop: {
      enabled: false,
      allowUserAddedConnections: false,
      preconfiguredConnections: [],
      requireManagedOrg: false,
      cacheMode: 'metadata-only',
      cacheEncryptionFallback: 'metadata-only',
    },
    cloudRegistry: null,
    cloudCredentialStore: null,
    cloudCache: null,
  })
  const workspaces = gateway.list(null)
  const local = workspaces.find((workspace) => workspace.id === LOCAL_WORKSPACE_ID)
  if (!local || local.kind !== 'local' || local.status !== 'online') {
    throw new Error('Local workspace boundary check failed.')
  }
  if (!gateway.isLocalWorkspace(null)) {
    throw new Error('Local workspace must remain active without a cloud dependency.')
  }
  return {
    workspaceId: local.id,
    status: local.status,
    localFiles: 'not uploaded',
  }
}

async function runSmoke() {
  const baseUrl = requireCloudUrl()
  debug(`cloud url ${baseUrl}`)
  const timeoutMs = intArg('timeout-ms', 'OPEN_COWORK_DESKTOP_SMOKE_TIMEOUT_MS', 30_000)
  const promptText = argOrEnv(
    'prompt',
    'OPEN_COWORK_DESKTOP_SMOKE_PROMPT',
    `Open Cowork Desktop cloud sync smoke ${new Date().toISOString()}`,
  )
  const agent = argOrEnv('agent', 'OPEN_COWORK_DESKTOP_SMOKE_AGENT') || null
  const skipPrompt = boolArg('skip-prompt', 'OPEN_COWORK_DESKTOP_SMOKE_SKIP_PROMPT')
  debug('checking desktop auth config')
  const authConfig = await checkDesktopAuthConfig(baseUrl)
  debug('issuing or loading desktop token')
  const tokenState = await maybeIssueDesktopToken(baseUrl)
  let tokenRevocationComplete = false
  const webToken = tokenEnv('OPEN_COWORK_DESKTOP_SMOKE_WEB_TOKEN') || tokenState.desktopToken
  const webClient = transport(baseUrl, webToken)
  let tempRoot = null

  try {
    debug('loading workspace')
    const workspace = await webClient.getWorkspace()
    const connection = {
      id: cloudWorkspaceIdForBaseUrl(baseUrl),
      baseUrl,
      label: new URL(baseUrl).host,
      tenantId: workspace.tenantId,
      userId: workspace.userId,
      profileName: workspace.profileName,
      lastSyncedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-desktop-cloud-smoke-'))
    const cache = new FileCloudWorkspaceCache({
      path: join(tempRoot, 'cloud-workspace-cache.json'),
      mode: 'full',
      secretStorage: encryptedStorage(),
    })
    const desktop = createDesktopAdapter({
      baseUrl,
      token: tokenState.desktopToken,
      connection,
      cache,
    })

    debug('loading desktop cloud policy')
    const policy = await desktop.policy()
    if (policy.localFiles !== 'disabled' || policy.localStdioMcps !== 'disabled' || policy.machineRuntimeConfig !== 'disabled') {
      throw new Error('Cloud workspace policy must disable local files, local stdio MCPs, and machine runtime config.')
    }

    debug('creating desktop-originated session')
    const desktopCreated = await desktop.createSession()
    debug(`waiting for workspace SSE for ${desktopCreated.id}`)
    const desktopCreatedEvent = await waitForEvent(
      (onEvent, onError) => webClient.subscribeWorkspaceEvents({
        afterSequence: 0,
        onEvent,
        onError,
      }),
      (event) => event.type === 'session.created' && event.sessionId === desktopCreated.id,
      'workspace session.created SSE for Desktop-created session',
      timeoutMs,
    )
    debug('listing sessions from web client')
    const webSessions = await webClient.listSessions()
    if (!webSessions.some((session) => session.sessionId === desktopCreated.id)) {
      throw new Error('Cloud Web API could not see the Desktop-created cloud session.')
    }

    debug('creating web-originated session')
    const webCreatedView = await webClient.createSession()
    const webCreatedSessionId = cloudSessionId(webCreatedView)
    const desktopSessionsAfterWebCreate = await desktop.listSessions()
    if (!desktopSessionsAfterWebCreate.some((session) => session.id === webCreatedSessionId)) {
      throw new Error('Desktop cloud adapter could not see the Web-created cloud session.')
    }

    const results = {
      baseUrl,
      authConfig,
      workspace: {
        tenantBound: Boolean(workspace.tenantId),
        userBound: Boolean(workspace.userId),
        profileName: workspace.profileName,
      },
      token: {
        source: tokenState.tokenSource,
        tokenId: tokenState.issuedToken?.tokenId || null,
      },
      policy: {
        localFiles: policy.localFiles,
        localStdioMcps: policy.localStdioMcps,
        machineRuntimeConfig: policy.machineRuntimeConfig,
      },
      desktopCreated: {
        sessionId: desktopCreated.id,
        visibleToWeb: true,
        workspaceSse: {
          type: desktopCreatedEvent.type,
          sequence: desktopCreatedEvent.sequence,
        },
      },
      webCreated: {
        sessionId: webCreatedSessionId,
        visibleToDesktop: true,
      },
      prompt: { skipped: true },
      cache: { skipped: true },
      localWorkspace: assertLocalWorkspaceBoundary(),
      tokenRevocation: { skipped: true },
    }

    if (!skipPrompt) {
      debug('prompting from desktop')
      const beforeDesktopPrompt = projectionSequence(await webClient.getSession(desktopCreated.id))
      const desktopPromptEvent = waitForEvent(
        (onEvent, onError) => webClient.subscribeSessionEvents(desktopCreated.id, {
          afterSequence: beforeDesktopPrompt,
          onEvent,
          onError,
        }),
        (event) => event.sequence > beforeDesktopPrompt,
        'session SSE after Desktop prompt',
        timeoutMs,
      )
      await desktop.promptSession(desktopCreated.id, { text: promptText, agent })
      const webObservedDesktopPrompt = await desktopPromptEvent
      const desktopPromptView = await waitForSuccessfulPromptView(
        () => desktop.getSessionView(desktopCreated.id),
        beforeDesktopPrompt,
        'Desktop projection after Desktop prompt',
        timeoutMs,
      )

      debug('prompting from web')
      const beforeWebPrompt = projectionSequence(await webClient.getSession(webCreatedSessionId))
      const webPromptEvent = waitForEvent(
        (onEvent, onError) => desktop.subscribeSessionEvents(webCreatedSessionId, {
          afterSequence: beforeWebPrompt,
          onEvent,
          onError,
        }),
        (event) => event.sequence > beforeWebPrompt,
        'Desktop bearer-auth SSE after Web prompt',
        timeoutMs,
      )
      await webClient.promptSession(webCreatedSessionId, { text: `${promptText} from web`, agent })
      const desktopObservedWebPrompt = await webPromptEvent
      const webPromptView = await waitForSuccessfulPromptView(
        () => desktop.getSessionView(webCreatedSessionId),
        beforeWebPrompt,
        'Desktop projection after Web prompt',
        timeoutMs,
      )

      debug('sending desktop abort command')
      await desktop.abortSession(webCreatedSessionId)
      const artifacts = desktop.listArtifacts
        ? await desktop.listArtifacts(desktopCreated.id).catch(() => [])
        : []
      debug('checking offline cache fallback')
      const offline = new CloudWorkspaceAdapter({
        connection,
        transport: failingTransport(baseUrl),
        cache,
      })
      const cachedSessions = await offline.listSessions()
      if (!cachedSessions.some((session) => session.id === desktopCreated.id)) {
        throw new Error('Offline Desktop cache did not retain cloud session list.')
      }
      const cachedView = await offline.getSessionView(desktopCreated.id)
      await offline.promptSession(desktopCreated.id, { text: 'must not queue offline' })
        .then(() => {
          throw new Error('Offline Desktop cloud prompt unexpectedly succeeded.')
        })
        .catch((error) => {
          if (!String(error instanceof Error ? error.message : error).includes('offline')) throw error
        })

      results.prompt = {
        skipped: false,
        desktopPromptObservedByWebSse: {
          type: webObservedDesktopPrompt.type,
          sequence: webObservedDesktopPrompt.sequence,
        },
        webPromptObservedByDesktopSse: {
          type: desktopObservedWebPrompt.type,
          sequence: desktopObservedWebPrompt.sequence,
        },
        desktopView: outputViewShape(desktopPromptView),
        webViewOnDesktop: outputViewShape(webPromptView),
        abortCommandAccepted: true,
        artifactCount: Math.max(artifacts.length, Array.isArray(desktopPromptView.artifacts) ? desktopPromptView.artifacts.length : 0),
        artifactEndpointCount: artifacts.length,
      }
      results.cache = {
        skipped: false,
        mode: cache.mode,
        cachedSessions: cachedSessions.length,
        cachedView: outputViewShape(cachedView),
        offlineMutationsBlocked: true,
        cacheKeyPresent: Boolean(cloudWorkspaceCacheKey(connection)),
      }
    }

    debug('checking token revocation')
    results.tokenRevocation = await revokeAndVerify({
      adminClient: tokenState.adminClient,
      baseUrl,
      issuedToken: tokenState.issuedToken,
      desktopToken: tokenState.desktopToken,
    })
    tokenRevocationComplete = true

    return results
  } finally {
    if (!tokenRevocationComplete && tokenState.adminClient && tokenState.issuedToken) {
      try {
        await tokenState.adminClient.revokeApiToken(tokenState.issuedToken.tokenId)
      } catch (error) {
        process.stderr.write(`[desktop-cloud-smoke] Warning: failed to revoke ephemeral desktop token ${tokenState.issuedToken.tokenId}: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  }
}

runSmoke()
  .then((results) => {
    process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`)
  })
  .catch((error) => {
    process.stderr.write(`[desktop-cloud-smoke] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
