#!/usr/bin/env node
import { randomUUID } from 'node:crypto'

import { createHttpSseCloudTransportAdapter } from '../packages/cloud-client/dist/index.js'
import { createCloudGateway, createGatewayDaemon, resolveGatewayCloudConnection, resolveGatewayConfig } from '../apps/channel-gateway/dist/index.js'
import { WebhookCircuitOpenError } from '../packages/gateway-provider-webhook/dist/index.js'

const args = parseArgs(process.argv.slice(2))
const debugEnabled = process.env.OPEN_COWORK_GATEWAY_SMOKE_DEBUG === 'true'

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
  if (debugEnabled) process.stderr.write(`[gateway-cloud-smoke:debug] ${message}\n`)
}

function normalizeUrl(value, { allowInsecureHttp = false } = {}) {
  const raw = value.trim()
  if (!raw) throw new Error('URL is required.')
  const url = new URL(raw)
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.search = ''
  url.hash = ''
  const normalized = url.toString().replace(/\/+$/, '')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Gateway smoke URLs must be HTTP or HTTPS.')
  }
  if (url.protocol === 'http:' && !allowInsecureHttp && !isLoopbackHost(url.hostname)) {
    throw new Error('Gateway smoke Cloud/Gateway URLs must use HTTPS unless they are loopback or OPEN_COWORK_GATEWAY_SMOKE_ALLOW_INSECURE_HTTP=true is set.')
  }
  return normalized
}

function isLoopbackHost(hostname) {
  const host = hostname.trim().toLowerCase()
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function requireCloudUrl() {
  const raw = argOrEnv('cloud-url', 'OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL')
    || process.env.OPEN_COWORK_SMOKE_CLOUD_URL
  if (!raw) {
    throw new Error('Set OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL or pass --cloud-url for Gateway cloud smoke.')
  }
  return normalizeUrl(raw, {
    allowInsecureHttp: boolArg('allow-insecure-http', 'OPEN_COWORK_GATEWAY_SMOKE_ALLOW_INSECURE_HTTP'),
  })
}

function optionalGatewayUrl() {
  const raw = argOrEnv('gateway-url', 'OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL')
    || process.env.OPEN_COWORK_SMOKE_GATEWAY_URL
    || ''
  if (!raw) return null
  return normalizeUrl(raw, {
    allowInsecureHttp: boolArg('allow-insecure-http', 'OPEN_COWORK_GATEWAY_SMOKE_ALLOW_INSECURE_HTTP'),
  })
}

function transport(baseUrl, token) {
  return createHttpSseCloudTransportAdapter({
    baseUrl,
    headers: { authorization: `Bearer ${token}` },
  })
}

async function requestJson(url, input = {}) {
  const headers = {
    ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(input.headers || {}),
  }
  const response = await fetch(url, {
    method: input.method || 'GET',
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { response, status: response.status, body, text }
}

async function expectStatus(url, input, accepted) {
  const result = await requestJson(url, input)
  if (!accepted.includes(result.status)) {
    throw new Error(`${url} returned ${result.status}; expected ${accepted.join('/')} (${String(result.text).slice(0, 240)})`)
  }
  return result
}

async function expectOkJson(url, input = {}) {
  const result = await requestJson(url, input)
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${url} returned ${result.status}: ${String(result.text).slice(0, 240)}`)
  }
  return result.body
}

function requireMethod(client, methodName) {
  const method = client[methodName]
  if (typeof method !== 'function') throw new Error(`Cloud transport does not support ${methodName}.`)
  return method.bind(client)
}

async function issueGatewayToken(baseUrl) {
  const adminToken = tokenEnv('OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN')
  if (!adminToken) {
    throw new Error('Set OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN for the full Gateway deployment smoke.')
  }
  const adminClient = transport(baseUrl, adminToken)
  const issueApiToken = requireMethod(adminClient, 'issueApiToken')
  const ttlSeconds = intArg('token-ttl-seconds', 'OPEN_COWORK_GATEWAY_SMOKE_TOKEN_TTL_SECONDS', 15 * 60)
  const issued = await issueApiToken({
    name: `Gateway deployment smoke ${new Date().toISOString()}`,
    scopes: ['gateway'],
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  })
  return {
    adminToken,
    adminClient,
    serviceToken: issued.plaintext,
    issuedToken: issued.token,
  }
}

async function revokeGatewayToken({ adminClient, issuedToken, serviceToken, baseUrl }) {
  if (!adminClient || !issuedToken) return { skipped: true }
  const revokeApiToken = requireMethod(adminClient, 'revokeApiToken')
  const revoked = await revokeApiToken(issuedToken.tokenId)
  if (!revoked?.revokedAt) throw new Error('Gateway smoke token was not revoked.')
  if (boolArg('skip-token-revocation', 'OPEN_COWORK_GATEWAY_SMOKE_SKIP_TOKEN_REVOCATION')) {
    return {
      tokenId: issuedToken.tokenId,
      revokedAt: revoked.revokedAt,
      skipped: true,
      reason: 'explicit_skip',
    }
  }

  const response = await fetch(`${baseUrl}/api/channels/sessions/prompt`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ bindingId: 'revoked-token-check', text: 'must not mutate' }),
  })
  if (response.status === 401 || response.status === 403) {
    return {
      tokenId: issuedToken.tokenId,
      revokedAt: revoked.revokedAt,
      rejected: true,
    }
  }
  const text = await response.text()
  throw new Error(`Revoked gateway token returned ${response.status} instead of an auth failure: ${text.slice(0, 240)}`)
}

async function checkManagedGateway(gatewayUrl) {
  if (!gatewayUrl) {
    if (boolArg('require-managed-gateway', 'OPEN_COWORK_GATEWAY_SMOKE_REQUIRE_MANAGED')) {
      throw new Error('Set OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL for the managed Gateway smoke.')
    }
    return { skipped: true }
  }

  const adminToken = tokenEnv('OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN')
    || tokenEnv('OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN')
  const health = await expectOkJson(`${gatewayUrl}/health`)
  const ready = await expectOkJson(`${gatewayUrl}/ready`)

  const publicMetrics = await requestJson(`${gatewayUrl}/metrics`)
  if (publicMetrics.status === 200) throw new Error('Gateway /metrics must not be public.')
  const publicDiagnostics = await requestJson(`${gatewayUrl}/diagnostics`)
  if (publicDiagnostics.status === 200) throw new Error('Gateway /diagnostics must not be public.')

  const operator = { metrics: { skipped: true }, diagnostics: { skipped: true } }
  if (adminToken) {
    const metrics = await requestJson(`${gatewayUrl}/metrics`, { token: adminToken })
    if (![200, 404].includes(metrics.status)) {
      throw new Error(`Gateway operator /metrics returned ${metrics.status}.`)
    }
    operator.metrics = {
      status: metrics.status,
      exposed: metrics.status === 200,
    }
    const diagnostics = await requestJson(`${gatewayUrl}/diagnostics`, { token: adminToken })
    if (![200, 404].includes(diagnostics.status)) {
      throw new Error(`Gateway operator /diagnostics returned ${diagnostics.status}.`)
    }
    if (diagnostics.status === 200 && String(diagnostics.text).match(/Bearer\s+\S+|OPEN_COWORK_GATEWAY_SERVICE_TOKEN|serviceToken":"(?![^"]*redacted)/i)) {
      throw new Error('Gateway diagnostics exposed a raw service token.')
    }
    operator.diagnostics = {
      status: diagnostics.status,
      exposed: diagnostics.status === 200,
    }
  }

  return {
    url: gatewayUrl,
    health: {
      ok: Boolean(health?.ok),
      mode: health?.mode || null,
      branding: health?.branding?.productName ? 'present' : 'missing',
    },
    ready: {
      ok: Boolean(ready?.ok),
      providers: Array.isArray(ready?.providers) ? ready.providers.length : 0,
    },
    publicMetricsStatus: publicMetrics.status,
    publicDiagnosticsStatus: publicDiagnostics.status,
    operator,
  }
}

async function waitFor(getter, predicate, label, timeoutMs) {
  const startedAt = Date.now()
  let latest
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await getter()
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

function cloudSessionId(view) {
  const sessionId = view?.session?.sessionId
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Cloud session view did not include session.sessionId.')
  return sessionId
}

function projectionShape(view) {
  const projection = view?.projection
  const state = projection?.view
  return {
    sequence: typeof projection?.sequence === 'number' ? projection.sequence : 0,
    messages: Array.isArray(state?.messages) ? state.messages.length : 0,
    toolCalls: Array.isArray(state?.toolCalls) ? state.toolCalls.length : 0,
    pendingApprovals: Array.isArray(state?.pendingApprovals) ? state.pendingApprovals.length : 0,
    pendingQuestions: Array.isArray(state?.pendingQuestions) ? state.pendingQuestions.length : 0,
    artifacts: Array.isArray(state?.artifacts) ? state.artifacts.length : 0,
    errors: Array.isArray(state?.errors) ? state.errors.length : 0,
    lastError: typeof state?.lastError === 'string' ? state.lastError : null,
  }
}

function assertProjectionSucceeded(view) {
  const shape = projectionShape(view)
  if (shape.errors > 0 || shape.lastError) {
    throw new Error(`Gateway prompt produced cloud session errors: ${shape.lastError || 'projection errors'}`)
  }
  if (shape.messages < 1) {
    throw new Error('Gateway prompt did not produce assistant output in the cloud projection.')
  }
  return shape
}

async function patchChannelBinding(baseUrl, token, bindingId, input) {
  const result = await requestJson(`${baseUrl}/api/channels/bindings/${encodeURIComponent(bindingId)}`, {
    method: 'PATCH',
    token,
    body: input,
  })
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Channel binding patch returned ${result.status}: ${String(result.text).slice(0, 240)}`)
  }
  return result.body?.binding
}

async function createDelivery(baseUrl, token, input) {
  const result = await requestJson(`${baseUrl}/api/channels/deliveries`, {
    method: 'POST',
    token,
    body: input,
  })
  if (result.status !== 201) {
    throw new Error(`Channel delivery create returned ${result.status}: ${String(result.text).slice(0, 240)}`)
  }
  return result.body?.delivery
}

async function setupCloudChannelState({ baseUrl, adminToken, adminClient, serviceToken, runId }) {
  const createHeadlessAgent = requireMethod(adminClient, 'createHeadlessAgent')
  const listChannelBindings = requireMethod(adminClient, 'listChannelBindings')
  const createChannelBinding = requireMethod(adminClient, 'createChannelBinding')
  const resolveChannelIdentity = requireMethod(adminClient, 'resolveChannelIdentity')

  const agentId = `gw-smoke-agent-${runId}`
  const bindingId = `gw-smoke-binding-${runId}`
  const externalUserId = `gw-smoke-user-${runId}`
  const externalChatId = `gw-smoke-chat-${runId}`
  const externalThreadId = `gw-smoke-thread-${runId}`

  const agent = await createHeadlessAgent({
    agentId,
    name: `Gateway deployment smoke ${runId}`,
    profileName: argOrEnv('profile', 'OPEN_COWORK_GATEWAY_SMOKE_PROFILE', 'full'),
    status: 'active',
    managed: false,
  })
  const binding = await createChannelBinding({
    bindingId,
    agentId,
    provider: 'cli',
    displayName: `Gateway smoke CLI ${runId}`,
    status: 'active',
    settings: { smoke: true },
  })
  const listed = await listChannelBindings(agentId)
  if (!listed.some((entry) => entry.bindingId === bindingId)) {
    throw new Error('Cloud channel binding list did not include the smoke binding.')
  }
  await patchChannelBinding(baseUrl, adminToken, bindingId, { status: 'disabled' })
  const reactivated = await patchChannelBinding(baseUrl, adminToken, bindingId, { status: 'active' })
  if (reactivated?.status !== 'active') throw new Error('Cloud channel binding update did not reactivate the smoke binding.')

  const identity = await resolveChannelIdentity({
    provider: 'cli',
    externalUserId,
    role: 'member',
    status: 'active',
    metadata: { smoke: true },
  })
  if (identity.status !== 'active' || identity.role !== 'member') {
    throw new Error('Cloud channel identity was not provisioned as an active member.')
  }

  await expectStatus(`${baseUrl}/api/channels/agents`, {
    method: 'POST',
    token: serviceToken,
    body: {
      agentId: `forbidden-${runId}`,
      name: 'Forbidden gateway setup',
      profileName: 'full',
    },
  }, [403])
  await expectStatus(`${baseUrl}/api/api-tokens`, {
    method: 'POST',
    token: serviceToken,
    body: {
      name: 'forbidden nested token',
      scopes: ['gateway'],
    },
  }, [403])

  return {
    agent,
    binding,
    identity,
    ids: {
      agentId,
      bindingId,
      externalUserId,
      externalChatId,
      externalThreadId,
    },
  }
}

async function grantGatewayTokenChannelBinding(adminClient, issuedToken, channelBindingId) {
  const grantApiTokenChannelBinding = requireMethod(adminClient, 'grantApiTokenChannelBinding')
  const result = await grantApiTokenChannelBinding(issuedToken.tokenId, { channelBindingId })
  if (!result?.token?.channelBindingIds?.includes(channelBindingId)) {
    throw new Error('Gateway token channel binding grant was not applied.')
  }
  return result
}

async function runSelfHostGatewaySmoke({ baseUrl, serviceToken, adminToken, adminClient, setup, timeoutMs, runId }) {
  const gatewayAdminToken = `gateway-admin-${runId}`
  const gatewayEnv = {
    OPEN_COWORK_CLOUD_BASE_URL: baseUrl,
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: serviceToken,
    OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP: boolArg('allow-insecure-http', 'OPEN_COWORK_GATEWAY_SMOKE_ALLOW_INSECURE_HTTP') ? 'true' : 'false',
  }
  const gatewayConfig = resolveGatewayConfig({
    server: {
      host: '127.0.0.1',
      port: 0,
      adminToken: gatewayAdminToken,
    },
    mode: 'self-host',
    metrics: { enabled: true },
    diagnostics: { enabled: true },
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: setup.ids.bindingId,
    }],
  }, gatewayEnv)
  const gateway = createGatewayDaemon(gatewayConfig, createCloudGateway(resolveGatewayCloudConnection(gatewayEnv)))
  const gatewayUrl = await gateway.start()
  const fakeProvider = gateway.runtime.providers.get('fake')?.provider
  if (!fakeProvider || !Array.isArray(fakeProvider.sent)) {
    throw new Error('Gateway smoke fake provider was not available.')
  }
  const originalSendText = fakeProvider.sendText.bind(fakeProvider)
  const forcedDeliveryFailures = new Map()
  fakeProvider.sendText = async (...sendArgs) => {
    const options = sendArgs[2] && typeof sendArgs[2] === 'object' ? sendArgs[2] : {}
    const deliveryId = typeof options.deliveryId === 'string' ? options.deliveryId : ''
    const retryAfterMs = forcedDeliveryFailures.get(deliveryId)
    if (retryAfterMs !== undefined) {
      forcedDeliveryFailures.delete(deliveryId)
      throw new WebhookCircuitOpenError(retryAfterMs)
    }
    return originalSendText(...sendArgs)
  }

  try {
    const health = await expectOkJson(`${gatewayUrl}/health`)
    const ready = await expectOkJson(`${gatewayUrl}/ready`)
    await expectStatus(`${gatewayUrl}/metrics`, {}, [401])
    await expectStatus(`${gatewayUrl}/diagnostics`, {}, [401])
    const metrics = await expectStatus(`${gatewayUrl}/metrics`, { token: gatewayAdminToken }, [200])
    if (!String(metrics.text).includes('open_cowork_gateway_providers')) {
      throw new Error('Gateway metrics endpoint did not expose gateway metrics.')
    }
    const diagnostics = await expectStatus(`${gatewayUrl}/diagnostics`, { token: gatewayAdminToken }, [200])
    if (String(diagnostics.text).includes(serviceToken)) {
      throw new Error('Gateway diagnostics exposed the raw service token.')
    }

    const promptText = argOrEnv(
      'prompt',
      'OPEN_COWORK_GATEWAY_SMOKE_PROMPT',
      `Open Cowork Gateway deployment smoke ${new Date().toISOString()}`,
    )
    const promptResponse = await requestJson(`${gatewayUrl}/webhooks/fake`, {
      method: 'POST',
      body: {
        text: promptText,
        chatId: setup.ids.externalChatId,
        threadId: setup.ids.externalThreadId,
        userId: setup.ids.externalUserId,
      },
    })
    if (promptResponse.status !== 202) {
      throw new Error(`Gateway fake webhook prompt returned ${promptResponse.status}: ${String(promptResponse.text).slice(0, 240)}`)
    }

    const getChannelSessionByThread = requireMethod(adminClient, 'getChannelSessionByThread')
    const getSession = requireMethod(adminClient, 'getSession')
    const bound = await waitFor(
      () => getChannelSessionByThread({
        provider: 'cli',
        externalChatId: setup.ids.externalChatId,
        externalThreadId: setup.ids.externalThreadId,
      }),
      (value) => Boolean(value?.binding?.bindingId),
      'channel session binding after fake webhook prompt',
      timeoutMs,
    )
    const sessionId = cloudSessionId(bound.session)
    const promptView = await waitFor(
      async () => {
        const view = await getSession(sessionId)
        const shape = projectionShape(view)
        if (shape.errors > 0 || shape.lastError) {
          throw new Error(`Gateway prompt produced cloud session errors: ${shape.lastError || 'projection errors'}`)
        }
        return view
      },
      (view) => projectionShape(view).messages > 0,
      'assistant output from Gateway prompt',
      timeoutMs,
    )
    const promptProjection = assertProjectionSucceeded(promptView)
    await waitFor(
      () => fakeProvider.sent,
      (sent) => sent.some((entry) => typeof entry.text === 'string' && entry.text.length > 0),
      'channel rendering from session SSE',
      timeoutMs,
    )

    const createChannelInteraction = requireMethod(adminClient, 'createChannelInteraction')
    const interaction = await createChannelInteraction({
      agentId: setup.ids.agentId,
      sessionId,
      provider: 'cli',
      kind: 'permission',
      targetId: `gw-smoke-permission-${runId}`,
      externalInteractionId: `gw-smoke-interaction-${runId}`,
      createdByIdentityId: setup.identity.identityId,
    })
    const approvalToken = `apv:${interaction.plaintextToken}`
    const approvalResponse = await requestJson(`${gatewayUrl}/webhooks/fake`, {
      method: 'POST',
      body: {
        text: approvalToken,
        chatId: setup.ids.externalChatId,
        threadId: setup.ids.externalThreadId,
        userId: setup.ids.externalUserId,
        interaction: {
          id: `gw-smoke-callback-${runId}`,
          token: approvalToken,
          kind: 'button',
        },
      },
    })
    if (approvalResponse.status !== 202) {
      throw new Error(`Gateway fake approval returned ${approvalResponse.status}: ${String(approvalResponse.text).slice(0, 240)}`)
    }
    await waitFor(
      () => fakeProvider.answered,
      (answered) => answered.some((entry) => entry.interactionId === `gw-smoke-callback-${runId}`),
      'channel approval acknowledgement',
      timeoutMs,
    )

    const deliveryId = `gw-smoke-delivery-${runId}`
    await createDelivery(baseUrl, adminToken, {
      deliveryId,
      agentId: setup.ids.agentId,
      channelBindingId: setup.ids.bindingId,
      sessionBindingId: bound.binding.bindingId,
      provider: 'cli',
      target: {
        externalChatId: setup.ids.externalChatId,
        externalThreadId: setup.ids.externalThreadId,
      },
      eventType: 'workflow.completed',
      payload: { text: `Gateway smoke delivery ${runId}` },
    })
    await waitFor(
      () => fakeProvider.sent,
      (sent) => sent.some((entry) => entry.text === `Gateway smoke delivery ${runId}`),
      'async/proactive channel delivery rendering',
      timeoutMs,
    )
    const listChannelDeliveries = requireMethod(adminClient, 'listChannelDeliveries')
    const sentDelivery = await waitFor(
      async () => (await listChannelDeliveries({ channelBindingId: setup.ids.bindingId, limit: 50 }))
        .find((delivery) => delivery.deliveryId === deliveryId),
      (delivery) => delivery?.status === 'sent',
      'gateway delivery acknowledgement',
      timeoutMs,
    )

    const failedRetryId = `gw-smoke-retry-${runId}`
    forcedDeliveryFailures.set(failedRetryId, 60_000)
    await createDelivery(baseUrl, adminToken, {
      deliveryId: failedRetryId,
      agentId: setup.ids.agentId,
      channelBindingId: setup.ids.bindingId,
      provider: 'cli',
      target: { externalChatId: setup.ids.externalChatId, externalThreadId: setup.ids.externalThreadId },
      eventType: 'workflow.completed',
      payload: { text: 'retry later' },
    })
    await waitFor(
      () => expectOkJson(`${gatewayUrl}/deliveries?status=failed&channelBindingId=${encodeURIComponent(setup.ids.bindingId)}`, {
        token: gatewayAdminToken,
      }),
      (backlog) => Array.isArray(backlog.deliveries) && backlog.deliveries.some((delivery) => delivery.deliveryId === failedRetryId),
      'gateway-owned failed smoke retry delivery',
      timeoutMs,
    )
    const gatewayRetry = await requestJson(`${gatewayUrl}/deliveries/${encodeURIComponent(failedRetryId)}/retry`, {
      method: 'POST',
      token: gatewayAdminToken,
    })
    if (gatewayRetry.status < 200 || gatewayRetry.status >= 300) {
      throw new Error(`Gateway admin delivery retry returned ${gatewayRetry.status}: ${String(gatewayRetry.text).slice(0, 240)}`)
    }
    const retried = gatewayRetry.body?.delivery
    if (retried?.status !== 'failed') throw new Error('Gateway admin delivery retry did not move the failed delivery back into retry eligibility.')
    await waitFor(
      () => fakeProvider.sent,
      (sent) => sent.some((entry) => entry.text === 'retry later'),
      'retried channel delivery rendering',
      timeoutMs,
    )
    const retriedSent = await waitFor(
      async () => (await listChannelDeliveries({ channelBindingId: setup.ids.bindingId, limit: 50 }))
        .find((delivery) => delivery.deliveryId === failedRetryId),
      (delivery) => delivery?.status === 'sent',
      'retried delivery acknowledgement',
      timeoutMs,
    )

    const failedDeadId = `gw-smoke-dead-${runId}`
    forcedDeliveryFailures.set(failedDeadId, 60_000)
    await createDelivery(baseUrl, adminToken, {
      deliveryId: failedDeadId,
      agentId: setup.ids.agentId,
      channelBindingId: setup.ids.bindingId,
      provider: 'cli',
      target: { externalChatId: setup.ids.externalChatId, externalThreadId: setup.ids.externalThreadId },
      eventType: 'workflow.completed',
      payload: { text: 'dead letter me' },
    })
    await waitFor(
      () => expectOkJson(`${gatewayUrl}/deliveries?status=failed&channelBindingId=${encodeURIComponent(setup.ids.bindingId)}`, {
        token: gatewayAdminToken,
      }),
      (backlog) => Array.isArray(backlog.deliveries) && backlog.deliveries.some((delivery) => delivery.deliveryId === failedDeadId),
      'gateway-owned failed smoke dead-letter delivery',
      timeoutMs,
    )
    const gatewayDeadLetter = await requestJson(`${gatewayUrl}/deliveries/${encodeURIComponent(failedDeadId)}/dead-letter`, {
      method: 'POST',
      token: gatewayAdminToken,
      body: { lastError: 'gateway smoke operator dead-letter' },
    })
    if (gatewayDeadLetter.status < 200 || gatewayDeadLetter.status >= 300) {
      throw new Error(`Gateway admin delivery dead-letter returned ${gatewayDeadLetter.status}: ${String(gatewayDeadLetter.text).slice(0, 240)}`)
    }
    const dead = gatewayDeadLetter.body?.delivery
    if (dead?.status !== 'dead') throw new Error('Gateway admin delivery dead-letter did not return a dead delivery.')

    return {
      gatewayUrl,
      health: { ok: Boolean(health?.ok), mode: health?.mode || null },
      ready: { ok: Boolean(ready?.ok), providers: Array.isArray(ready?.providers) ? ready.providers.length : 0 },
      prompt: {
        sessionId,
        commandAccepted: true,
        projection: promptProjection,
        renderedMessages: fakeProvider.sent.length,
      },
      interaction: {
        acknowledged: true,
      },
      delivery: {
        deliveryId: sentDelivery.deliveryId,
        status: sentDelivery.status,
        retryInitialStatus: retried.status,
        retryStatus: retriedSent.status,
        deadLetterStatus: dead.status,
        gatewayOperatorRetryStatus: gatewayRetry.status,
        gatewayOperatorDeadLetterStatus: gatewayDeadLetter.status,
      },
      operatorEndpoints: {
        metrics: 'admin_only',
        diagnostics: 'admin_only',
      },
    }
  } finally {
    await gateway.stop()
  }
}

async function runSmoke() {
  const baseUrl = requireCloudUrl()
  const managedGatewayUrl = optionalGatewayUrl()
  const timeoutMs = intArg('timeout-ms', 'OPEN_COWORK_GATEWAY_SMOKE_TIMEOUT_MS', 30_000)
  const runId = randomUUID().replace(/-/g, '').slice(0, 12)
  debug(`cloud url ${baseUrl}`)
  debug(`run id ${runId}`)

  const tokenState = await issueGatewayToken(baseUrl)
  let tokenRevoked = false
  try {
    const setup = await setupCloudChannelState({
      baseUrl,
      adminToken: tokenState.adminToken,
      adminClient: tokenState.adminClient,
      serviceToken: tokenState.serviceToken,
      runId,
    })
    await grantGatewayTokenChannelBinding(tokenState.adminClient, tokenState.issuedToken, setup.ids.bindingId)
    const managed = await checkManagedGateway(managedGatewayUrl)
    const selfHost = await runSelfHostGatewaySmoke({
      baseUrl,
      serviceToken: tokenState.serviceToken,
      adminToken: tokenState.adminToken,
      adminClient: tokenState.adminClient,
      setup,
      timeoutMs,
      runId,
    })
    const tokenRevocation = await revokeGatewayToken({
      adminClient: tokenState.adminClient,
      issuedToken: tokenState.issuedToken,
      serviceToken: tokenState.serviceToken,
      baseUrl,
    })
    tokenRevoked = true
    return {
      baseUrl,
      managed,
      selfHost,
      cloudSetup: {
        agentId: setup.ids.agentId,
        bindingId: setup.ids.bindingId,
        identityStatus: setup.identity.status,
        gatewayTokenScope: 'gateway',
        leastPrivilegeChecks: ['channel_admin_forbidden', 'api_token_admin_forbidden'],
      },
      token: {
        tokenId: tokenState.issuedToken.tokenId,
        source: 'ephemeral',
      },
      tokenRevocation,
    }
  } finally {
    if (!tokenRevoked && tokenState.adminClient && tokenState.issuedToken) {
      try {
        const revokeApiToken = requireMethod(tokenState.adminClient, 'revokeApiToken')
        await revokeApiToken(tokenState.issuedToken.tokenId)
      } catch (error) {
        process.stderr.write(`[gateway-cloud-smoke] Warning: failed to revoke ephemeral gateway token ${tokenState.issuedToken.tokenId}: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }
}

runSmoke()
  .then((results) => {
    process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`)
  })
  .catch((error) => {
    process.stderr.write(`[gateway-cloud-smoke] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
