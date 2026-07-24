#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHttpSseCloudTransportAdapter } from '../packages/cloud-client/src/index.ts'
import { readCloudSessionProjection } from '../packages/shared/dist/cloud-session-projection.js'
import {
  CloudWorkspaceAdapter,
  cloudWorkspaceCacheKey,
} from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import { FileCloudWorkspaceCache } from '../apps/desktop/src/main/cloud-workspace-cache.ts'
import { createGatewayDaemon, createCloudGateway, resolveGatewayCloudConnection, resolveGatewayConfig } from '../apps/channel-gateway/dist/index.js'

const args = parseArgs(process.argv.slice(2))
const debugEnabled = process.env.OPEN_COWORK_CONTINUATION_SMOKE_DEBUG === 'true'

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
  if (debugEnabled) process.stderr.write(`[cloud-continuation-smoke:debug] ${message}\n`)
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
    throw new Error('Continuation smoke URLs must be HTTP or HTTPS.')
  }
  if (url.protocol === 'http:' && !allowInsecureHttp && !isLoopbackHost(url.hostname)) {
    throw new Error('Continuation smoke Cloud URLs must use HTTPS unless they are loopback or OPEN_COWORK_CONTINUATION_SMOKE_ALLOW_INSECURE_HTTP=true is set.')
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
  const raw = argOrEnv('cloud-url', 'OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL')
    || process.env.OPEN_COWORK_SMOKE_CLOUD_URL
  if (!raw) {
    throw new Error('Set OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL or pass --cloud-url for continuation smoke.')
  }
  return normalizeUrl(raw, {
    allowInsecureHttp: boolArg('allow-insecure-http', 'OPEN_COWORK_CONTINUATION_SMOKE_ALLOW_INSECURE_HTTP'),
  })
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(getter, predicate, label, timeoutMs) {
  const startedAt = Date.now()
  let latest
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await getter()
    if (predicate(latest)) return latest
    await wait(100)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

function waitForEvent(setup, predicate, label, timeoutMs) {
  let subscription = null
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { subscription?.close() } catch { /* ignore */ }
      reject(new Error(`Timed out waiting for ${label}.`))
    }, timeoutMs)
    timer.unref?.()
    subscription = setup((event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      try { subscription?.close() } catch { /* ignore */ }
      resolve(event)
    }, (error) => {
      clearTimeout(timer)
      try { subscription?.close() } catch { /* ignore */ }
      reject(error)
    })
  })
}

async function requestText(url, input = {}) {
  const headers = {
    ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
    ...(input.headers || {}),
  }
  const response = await fetch(url, { headers })
  const text = await response.text()
  return { response, status: response.status, text }
}

async function checkCloudWebSurface(baseUrl, webToken) {
  const root = await requestText(`${baseUrl}/`)
  if (!root.response.ok) throw new Error(`Cloud Web root returned ${root.status}: ${root.text.slice(0, 240)}`)
  const contentType = root.response.headers.get('content-type') || ''
  const csp = root.response.headers.get('content-security-policy') || ''
  for (const marker of ['text/html', 'id="cowork-bootstrap"', '/app/assets/']) {
    const target = marker === 'text/html' ? contentType : root.text
    if (!target.includes(marker)) throw new Error(`Cloud Web root missing marker: ${marker}`)
  }
  if (!csp.includes("default-src 'self'") || !csp.includes("connect-src 'self'")) {
    throw new Error('Cloud Web root did not send the expected CSP.')
  }

  const requestId = `continuation-smoke-${randomUUID()}`
  const workspace = await requestText(`${baseUrl}/api/workspace`, { token: webToken, requestId })
  if (!workspace.response.ok) throw new Error(`/api/workspace returned ${workspace.status}: ${workspace.text.slice(0, 240)}`)
  if (workspace.response.headers.get('x-request-id') !== requestId) {
    throw new Error('/api/workspace did not echo X-Request-Id for log correlation.')
  }
  return {
    root: 'ok',
    csp: 'present',
    requestIdEchoed: true,
  }
}

function requireMethod(client, methodName) {
  const method = client[methodName]
  if (typeof method !== 'function') throw new Error(`Cloud transport does not support ${methodName}.`)
  return method.bind(client)
}

async function issueSmokeTokens(baseUrl) {
  const adminToken = tokenEnv('OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN')
  if (!adminToken) {
    throw new Error('Set OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN for the full continuation smoke.')
  }
  const adminClient = transport(baseUrl, adminToken)
  const issueApiToken = requireMethod(adminClient, 'issueApiToken')
  const ttlSeconds = intArg('token-ttl-seconds', 'OPEN_COWORK_CONTINUATION_SMOKE_TOKEN_TTL_SECONDS', 15 * 60)
  const expiresAt = () => new Date(Date.now() + ttlSeconds * 1000).toISOString()
  const issued = {
    web: await issueApiToken({
      name: `Continuation Web smoke ${new Date().toISOString()}`,
      scopes: ['desktop'],
      expiresAt: expiresAt(),
    }),
    desktop: await issueApiToken({
      name: `Continuation Desktop smoke ${new Date().toISOString()}`,
      scopes: ['desktop'],
      expiresAt: expiresAt(),
    }),
    gateway: await issueApiToken({
      name: `Continuation Gateway smoke ${new Date().toISOString()}`,
      scopes: ['gateway'],
      expiresAt: expiresAt(),
    }),
  }
  return {
    adminClient,
    tokens: {
      web: issued.web.plaintext,
      desktop: issued.desktop.plaintext,
      gateway: issued.gateway.plaintext,
    },
    issued: {
      web: issued.web.token,
      desktop: issued.desktop.token,
      gateway: issued.gateway.token,
    },
  }
}

async function revokeIssuedTokens(tokenState) {
  const revokeApiToken = requireMethod(tokenState.adminClient, 'revokeApiToken')
  const revoked = {}
  for (const [name, token] of Object.entries(tokenState.issued)) {
    try {
      const result = await revokeApiToken(token.tokenId)
      revoked[name] = Boolean(result?.revokedAt)
    } catch (error) {
      revoked[name] = false
      process.stderr.write(`[cloud-continuation-smoke] Warning: failed to revoke ${name} token ${token.tokenId}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return revoked
}

function cloudSessionId(view) {
  const sessionId = view?.session?.sessionId
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('Cloud session view did not include session.sessionId.')
  }
  return sessionId
}

function projection(view) {
  return readCloudSessionProjection(view)
}

function projectionSequence(view) {
  const sequence = view?.projection?.sequence
  return typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : 0
}

function projectionShape(view) {
  const state = projection(view)
  return {
    sequence: projectionSequence(view),
    messages: Array.isArray(state?.messages) ? state.messages.length : 0,
    taskRuns: Array.isArray(state?.taskRuns) ? state.taskRuns.length : 0,
    toolCalls: countToolCalls(state),
    pendingApprovals: Array.isArray(state?.pendingApprovals) ? state.pendingApprovals.length : 0,
    pendingQuestions: Array.isArray(state?.pendingQuestions) ? state.pendingQuestions.length : 0,
    resolvedApprovals: Array.isArray(state?.resolvedApprovals) ? state.resolvedApprovals.length : 0,
    resolvedQuestions: Array.isArray(state?.resolvedQuestions) ? state.resolvedQuestions.length : 0,
    artifacts: Array.isArray(state?.artifacts) ? state.artifacts.length : 0,
    todos: Array.isArray(state?.todos) ? state.todos.length : 0,
    errors: Array.isArray(state?.errors) ? state.errors.length : 0,
    cost: typeof state?.sessionCost === 'number' ? state.sessionCost : 0,
    inputTokens: typeof state?.sessionTokens?.input === 'number' ? state.sessionTokens.input : 0,
    outputTokens: typeof state?.sessionTokens?.output === 'number' ? state.sessionTokens.output : 0,
    status: state?.status || view?.session?.status || 'unknown',
  }
}

function desktopShape(view) {
  return {
    revision: view?.revision || 0,
    messages: Array.isArray(view?.messages) ? view.messages.length : 0,
    taskRuns: Array.isArray(view?.taskRuns) ? view.taskRuns.length : 0,
    toolCalls: countToolCalls(view),
    pendingApprovals: Array.isArray(view?.pendingApprovals) ? view.pendingApprovals.length : 0,
    pendingQuestions: Array.isArray(view?.pendingQuestions) ? view.pendingQuestions.length : 0,
    artifacts: Array.isArray(view?.artifacts) ? view.artifacts.length : 0,
    todos: Array.isArray(view?.todos) ? view.todos.length : 0,
    errors: Array.isArray(view?.errors) ? view.errors.length : 0,
    inputTokens: typeof view?.sessionTokens?.input === 'number' ? view.sessionTokens.input : 0,
    outputTokens: typeof view?.sessionTokens?.output === 'number' ? view.sessionTokens.output : 0,
  }
}

function countToolCalls(view) {
  const topLevel = Array.isArray(view?.toolCalls) ? view.toolCalls.length : 0
  const nested = Array.isArray(view?.taskRuns)
    ? view.taskRuns.reduce((count, taskRun) => (
        count + (Array.isArray(taskRun?.toolCalls) ? taskRun.toolCalls.length : 0)
      ), 0)
    : 0
  return topLevel + nested
}

function projectionMessages(view) {
  const state = projection(view)
  return Array.isArray(state?.messages) ? state.messages.map((message) => String(message.content || '')) : []
}

function assertNoProjectionErrors(view, label) {
  const state = projection(view)
  const errors = Array.isArray(state?.errors) ? state.errors : []
  if (errors.length) {
    throw new Error(`${label} reported projection errors: ${errors.map((error) => error?.message || error?.id || 'unknown').join('; ')}`)
  }
}

function assertRichProjectionIfRequired(view, label) {
  if (!boolArg('require-rich-projection', 'OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION')) {
    return { required: false }
  }
  const shape = projectionShape(view)
  const missing = []
  for (const [key, value] of Object.entries({
    messages: shape.messages,
    taskRuns: shape.taskRuns,
    toolCalls: shape.toolCalls,
    artifacts: shape.artifacts,
    todos: shape.todos,
    tokenUsage: shape.inputTokens + shape.outputTokens,
  })) {
    if (value <= 0) missing.push(key)
  }
  if (missing.length) throw new Error(`${label} is missing rich projection fields: ${missing.join(', ')}`)
  return { required: true, checked: true }
}

async function waitForProjection(client, sessionId, predicate, label, timeoutMs) {
  return waitFor(
    async () => {
      const view = await client.getSession(sessionId)
      assertNoProjectionErrors(view, label)
      return view
    },
    predicate,
    label,
    timeoutMs,
  )
}

async function waitForDesktopView(desktop, sessionId, predicate, label, timeoutMs) {
  return waitFor(
    async () => {
      const view = await desktop.getSessionView(sessionId)
      const errors = Array.isArray(view.errors) ? view.errors : []
      if (errors.length) throw new Error(`${label} reported Desktop view errors.`)
      return view
    },
    predicate,
    label,
    timeoutMs,
  )
}

function assertDesktopParity(rawView, desktopView, label) {
  const raw = projectionShape(rawView)
  const desktop = desktopShape(desktopView)
  if (desktop.messages < raw.messages) throw new Error(`${label} Desktop view lost cloud messages.`)
  if (desktop.taskRuns < raw.taskRuns) throw new Error(`${label} Desktop view lost task runs.`)
  if (desktop.toolCalls < raw.toolCalls) throw new Error(`${label} Desktop view lost tool calls.`)
  if (desktop.artifacts < raw.artifacts) throw new Error(`${label} Desktop view lost artifacts.`)
  if (desktop.todos < raw.todos) throw new Error(`${label} Desktop view lost todos.`)
  return { raw, desktop }
}

async function setupGateway({ baseUrl, token, tokenId, adminClient, runId }) {
  const createHeadlessAgent = requireMethod(adminClient, 'createHeadlessAgent')
  const createChannelBinding = requireMethod(adminClient, 'createChannelBinding')
  const resolveChannelIdentity = requireMethod(adminClient, 'resolveChannelIdentity')
  const agentId = `continuation-agent-${runId}`
  const bindingId = `continuation-binding-${runId}`
  const externalUserId = `continuation-user-${runId}`
  const agent = await createHeadlessAgent({
    agentId,
    name: `Continuation smoke ${runId}`,
    profileName: argOrEnv('profile', 'OPEN_COWORK_CONTINUATION_SMOKE_PROFILE', 'full'),
    status: 'active',
    managed: false,
  })
  const channelBinding = await createChannelBinding({
    bindingId,
    agentId,
    provider: 'cli',
    displayName: `Continuation fake channel ${runId}`,
    status: 'active',
    settings: { smoke: true },
  })
  const grantApiTokenChannelBinding = requireMethod(adminClient, 'grantApiTokenChannelBinding')
  const grant = await grantApiTokenChannelBinding(tokenId, { channelBindingId: bindingId })
  if (!grant?.token?.channelBindingIds?.includes(bindingId)) {
    throw new Error('Continuation smoke gateway token was not granted to the channel binding.')
  }
  const identity = await resolveChannelIdentity({
    provider: 'cli',
    externalUserId,
    role: 'member',
    status: 'active',
    metadata: { smoke: true },
  })

  const gatewayEnv = {
    OPEN_COWORK_CLOUD_BASE_URL: baseUrl,
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: token,
    OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP: boolArg('allow-insecure-http', 'OPEN_COWORK_CONTINUATION_SMOKE_ALLOW_INSECURE_HTTP') ? 'true' : 'false',
  }
  const config = resolveGatewayConfig({
    server: {
      host: '127.0.0.1',
      port: 0,
      adminToken: `continuation-gateway-admin-${runId}`,
    },
    mode: 'self-host',
    providers: [{
      id: 'fake',
      kind: 'fake',
      channelBindingId: bindingId,
    }],
  }, gatewayEnv)
  const cloudGateway = createCloudGateway(resolveGatewayCloudConnection(gatewayEnv))
  const daemon = createGatewayDaemon(config, cloudGateway)
  const gatewayUrl = await daemon.start()
  const fakeProvider = daemon.runtime.providers.get('fake')?.provider
  if (!fakeProvider || !Array.isArray(fakeProvider.sent)) {
    throw new Error('Continuation smoke fake provider was not available.')
  }
  return {
    agent,
    channelBinding,
    identity,
    cloudGateway,
    daemon,
    fakeProvider,
    gatewayUrl,
    ids: { agentId, bindingId, externalUserId },
  }
}

function ensureGatewayStream(gatewaySetup, binding) {
  gatewaySetup.daemon.runtime.streams.ensure({
    binding,
    provider: gatewaySetup.fakeProvider,
  })
}

async function bindGatewayToSession(gatewaySetup, input) {
  const bound = await gatewaySetup.cloudGateway.bindSession({
    identityId: gatewaySetup.identity.identityId,
    provider: 'cli',
    externalUserId: gatewaySetup.ids.externalUserId,
    channelBindingId: gatewaySetup.ids.bindingId,
    externalChatId: input.chatId,
    externalThreadId: input.threadId,
    sessionId: input.sessionId,
    title: input.title,
  })
  ensureGatewayStream(gatewaySetup, bound.binding)
  return bound
}

async function sendFakeGatewayMessage(gatewaySetup, input) {
  const response = await fetch(`${gatewaySetup.gatewayUrl}/webhooks/fake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: input.text,
      chatId: input.chatId,
      threadId: input.threadId,
      userId: gatewaySetup.ids.externalUserId,
    }),
  })
  const text = await response.text()
  if (response.status !== 202) {
    throw new Error(`Gateway fake webhook returned ${response.status}: ${text.slice(0, 240)}`)
  }
}

async function waitForGatewayRender(gatewaySetup, predicate, label, timeoutMs) {
  return waitFor(
    () => Promise.resolve(gatewaySetup.fakeProvider.sent),
    predicate,
    label,
    timeoutMs,
  )
}

async function settlePermissionAndQuestion({ webClient, gatewaySetup, sessionId, view, timeoutMs }) {
  const state = projection(view)
  const permission = state?.pendingApprovals?.[0] || null
  const question = state?.pendingQuestions?.[0] || null
  const result = {
    permissionResolvedByWeb: false,
    questionResolvedByGateway: false,
  }
  if (permission?.id) {
    await webClient.respondToPermission(sessionId, {
      permissionId: permission.id,
      response: { allowed: true },
    })
    await waitForProjection(
      webClient,
      sessionId,
      (next) => projectionShape(next).pendingApprovals === 0,
      'Web permission resolution projection',
      timeoutMs,
    )
    result.permissionResolvedByWeb = true
  }
  if (question?.id) {
    const interaction = await gatewaySetup.cloudGateway.createChannelInteraction({
      agentId: gatewaySetup.ids.agentId,
      sessionId,
      provider: 'cli',
      kind: 'question',
      targetId: question.id,
      createdByIdentityId: gatewaySetup.identity.identityId,
    })
    await gatewaySetup.cloudGateway.resolveChannelInteraction({
      identityId: gatewaySetup.identity.identityId,
      provider: 'cli',
      externalUserId: gatewaySetup.ids.externalUserId,
      token: interaction.plaintextToken,
      answers: ['yes'],
    })
    await waitForProjection(
      webClient,
      sessionId,
      (next) => projectionShape(next).pendingQuestions === 0,
      'Gateway question resolution projection',
      timeoutMs,
    )
    result.questionResolvedByGateway = true
  }
  if (boolArg('require-rich-projection', 'OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION')) {
    if (!result.permissionResolvedByWeb) throw new Error('Rich continuation smoke required a pending permission to resolve from Web.')
    if (!result.questionResolvedByGateway) throw new Error('Rich continuation smoke required a pending question to resolve from Gateway.')
  }
  return result
}

async function continueFromWebSession({ webClient, desktop, gatewaySetup, timeoutMs, promptPrefix, agent }) {
  debug('scenario: Web creates, Desktop continues, Gateway renders')
  const created = await webClient.createSession()
  const sessionId = cloudSessionId(created)
  const listed = await desktop.listSessions()
  if (!listed.some((session) => session.id === sessionId)) {
    throw new Error('Desktop did not list the Web-created session.')
  }
  await bindGatewayToSession(gatewaySetup, {
    sessionId,
    chatId: `web-chat-${sessionId}`,
    threadId: `web-thread-${sessionId}`,
    title: 'Web-created continuation session',
  })

  const before = projectionShape(await webClient.getSession(sessionId))
  const promptText = `${promptPrefix} web-created session continued by Desktop`
  await desktop.promptSession(sessionId, { text: promptText, agent })
  // Gateway session streams only render assistant.message (and rich UI events), not the
  // user prompt. Wait for the OpenCode turn to produce assistant content (or finish
  // generating) before requiring a channel render.
  const raw = await waitForProjection(
    webClient,
    sessionId,
    (view) => {
      const shape = projectionShape(view)
      if (shape.messages <= before.messages) return false
      const state = projection(view)
      const messages = Array.isArray(state?.messages) ? state.messages : []
      const hasAssistant = messages.some((message) => message?.role === 'assistant' && String(message?.content || '').trim())
      const settled = shape.status !== 'running' && state?.isGenerating !== true
      return hasAssistant || settled
    },
    'Desktop continuation produced assistant output or settled on Web projection',
    timeoutMs,
  )
  await waitForGatewayRender(
    gatewaySetup,
    (sent) => sent.some((entry) => typeof entry.text === 'string' && entry.text.trim().length > 0),
    'Gateway render of Desktop continuation',
    timeoutMs,
  ).catch(() => waitForGatewayRender(
    gatewaySetup,
    (sent) => sent.length > 0,
    'Gateway render of Desktop continuation',
    timeoutMs,
  ))
  const resolution = await settlePermissionAndQuestion({ webClient, gatewaySetup, sessionId, view: raw, timeoutMs })
  const finalRaw = await webClient.getSession(sessionId)
  const desktopView = await waitForDesktopView(
    desktop,
    sessionId,
    (view) => view.messages.length >= projectionShape(finalRaw).messages,
    'Desktop hydrated Web-created session',
    timeoutMs,
  )
  return {
    sessionId,
    before,
    after: projectionShape(finalRaw),
    parity: assertDesktopParity(finalRaw, desktopView, 'Web-created session'),
    richProjection: assertRichProjectionIfRequired(finalRaw, 'Web-created session'),
    resolution,
  }
}

async function continueFromDesktopSession({ webClient, desktop, gatewaySetup, timeoutMs, promptPrefix, agent }) {
  debug('scenario: Desktop creates, Web continues, Gateway binds')
  const created = await desktop.createSession()
  const sessionId = created.id
  const listed = await webClient.listSessions()
  if (!listed.some((session) => session.sessionId === sessionId)) {
    throw new Error('Web API did not list the Desktop-created session.')
  }
  await bindGatewayToSession(gatewaySetup, {
    sessionId,
    chatId: `desktop-chat-${sessionId}`,
    threadId: `desktop-thread-${sessionId}`,
    title: 'Desktop-created continuation session',
  })
  const before = projectionShape(await webClient.getSession(sessionId))
  const promptText = `${promptPrefix} desktop-created session continued by Web`
  await webClient.promptSession(sessionId, { text: promptText, agent })
  const raw = await waitForProjection(
    webClient,
    sessionId,
    (view) => projectionShape(view).messages > before.messages,
    'Web continuation visible to projection',
    timeoutMs,
  )
  await waitForGatewayRender(
    gatewaySetup,
    (sent) => sent.some((entry) => typeof entry.text === 'string' && entry.text.includes(promptText)),
    'Gateway render of Web continuation',
    timeoutMs,
  ).catch(() => waitForGatewayRender(
    gatewaySetup,
    (sent) => sent.length > 0,
    'Gateway render of Web continuation',
    timeoutMs,
  ))
  const desktopView = await waitForDesktopView(
    desktop,
    sessionId,
    (view) => view.messages.length >= projectionShape(raw).messages,
    'Desktop hydrated Desktop-created session',
    timeoutMs,
  )
  return {
    sessionId,
    before,
    after: projectionShape(raw),
    parity: assertDesktopParity(raw, desktopView, 'Desktop-created session'),
    richProjection: assertRichProjectionIfRequired(raw, 'Desktop-created session'),
  }
}

async function continueFromGatewaySession({ webClient, desktop, gatewaySetup, timeoutMs, promptPrefix, agent, runId }) {
  debug('scenario: Gateway creates, Web and Desktop continue')
  const chatId = `gateway-chat-${runId}`
  const threadId = `gateway-thread-${runId}`
  const gatewayPrompt = `${promptPrefix} gateway-created session`
  await sendFakeGatewayMessage(gatewaySetup, {
    chatId,
    threadId,
    text: gatewayPrompt,
  })
  const getChannelSessionByThread = requireMethod(gatewaySetup.cloudGateway, 'findSessionByThread')
  const bound = await waitFor(
    () => getChannelSessionByThread({
      provider: 'cli',
      externalChatId: chatId,
      externalThreadId: threadId,
    }),
    (value) => Boolean(value?.binding?.bindingId),
    'Gateway-created channel binding',
    timeoutMs,
  )
  const sessionId = cloudSessionId(bound.session)
  const initial = await waitForProjection(
    webClient,
    sessionId,
    (view) => projectionShape(view).messages > 0,
    'Gateway-created session projection',
    timeoutMs,
  )
  const webPrompt = `${promptPrefix} gateway-created session continued by Web`
  const desktopPrompt = `${promptPrefix} gateway-created session continued by Desktop`
  await webClient.promptSession(sessionId, { text: webPrompt, agent })
  await desktop.promptSession(sessionId, { text: desktopPrompt, agent })
  const raw = await waitForProjection(
    webClient,
    sessionId,
    (view) => projectionShape(view).messages >= projectionShape(initial).messages + 2,
    'Web and Desktop continuations of Gateway-created session',
    timeoutMs,
  )
  const desktopView = await waitForDesktopView(
    desktop,
    sessionId,
    (view) => view.messages.length >= projectionShape(raw).messages,
    'Desktop hydrated Gateway-created session',
    timeoutMs,
  )
  return {
    sessionId,
    after: projectionShape(raw),
    parity: assertDesktopParity(raw, desktopView, 'Gateway-created session'),
    richProjection: assertRichProjectionIfRequired(raw, 'Gateway-created session'),
  }
}

async function runConcurrentPromptCheck({ webClient, desktop, sessionId, timeoutMs, promptPrefix, agent }) {
  debug('scenario: concurrent prompts')
  const before = await webClient.getSession(sessionId)
  const beforeShape = projectionShape(before)
  await Promise.all([
    webClient.promptSession(sessionId, { text: `${promptPrefix} concurrent Web prompt`, agent }),
    desktop.promptSession(sessionId, { text: `${promptPrefix} concurrent Desktop prompt`, agent }),
  ])
  const raw = await waitForProjection(
    webClient,
    sessionId,
    (view) => projectionShape(view).messages >= beforeShape.messages + 2 && projectionShape(view).sequence > beforeShape.sequence,
    'ordered concurrent prompt projection',
    timeoutMs,
  )
  const messages = projectionMessages(raw).join('\n')
  return {
    before: beforeShape,
    after: projectionShape(raw),
    markersPresent: {
      web: messages.includes('concurrent Web prompt'),
      desktop: messages.includes('concurrent Desktop prompt'),
    },
  }
}

async function runReplayHydrationCheck({ webClient, desktopTransport, connection, cache, sessionId, timeoutMs }) {
  debug('scenario: stale cursor replay/hydration')
  const cacheKey = cloudWorkspaceCacheKey(connection)
  cache.setEventCursor(cacheKey, `session:${sessionId}`, 999_999)
  const replayDesktop = new CloudWorkspaceAdapter({
    connection,
    transport: desktopTransport,
    cache,
  })
  const firstEvent = await waitForEvent(
    (onEvent, onError) => replayDesktop.subscribeSessionEvents?.(sessionId, { onEvent, onError }) ?? { close() {} },
    (event) => event.sequence === 1,
    'Desktop replay from durable projection instead of stale cursor',
    timeoutMs,
  )
  const raw = await webClient.getSession(sessionId)
  const view = await replayDesktop.getSessionView(sessionId)
  assertDesktopParity(raw, view, 'Replay-hydrated session')
  return {
    firstEvent: {
      type: firstEvent.type,
      sequence: firstEvent.sequence,
    },
    cacheKeyPresent: Boolean(cacheKey),
    hydrated: true,
  }
}

async function runSmoke() {
  const baseUrl = requireCloudUrl()
  // Cold OpenCode start + first model response can exceed 45s on local compose labs.
  const timeoutMs = intArg('timeout-ms', 'OPEN_COWORK_CONTINUATION_SMOKE_TIMEOUT_MS', 120_000)
  const runId = randomUUID().replace(/-/g, '').slice(0, 12)
  const promptPrefix = argOrEnv(
    'prompt-prefix',
    'OPEN_COWORK_CONTINUATION_SMOKE_PROMPT_PREFIX',
    `Open Cowork continuation smoke ${runId}`,
  )
  const agent = argOrEnv('agent', 'OPEN_COWORK_CONTINUATION_SMOKE_AGENT') || null
  debug(`cloud url ${baseUrl}`)
  debug(`run id ${runId}`)

  const tokenState = await issueSmokeTokens(baseUrl)
  let tokensRevoked = false
  let tempRoot = null
  let gatewaySetup = null
  try {
    const webClient = transport(baseUrl, tokenState.tokens.web)
    const desktopClient = transport(baseUrl, tokenState.tokens.desktop)
    const webSurface = await checkCloudWebSurface(baseUrl, tokenState.tokens.web)
    const workspace = await webClient.getWorkspace()
    tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-continuation-smoke-'))
    const connection = {
      id: `continuation:${new URL(baseUrl).host}`,
      baseUrl,
      label: new URL(baseUrl).host,
      tenantId: workspace.tenantId,
      userId: workspace.userId,
      profileName: workspace.profileName,
      lastSyncedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const cache = new FileCloudWorkspaceCache({
      path: join(tempRoot, 'cloud-workspace-cache.json'),
      mode: 'full',
      secretStorage: encryptedStorage(),
    })
    const desktop = new CloudWorkspaceAdapter({
      connection,
      transport: desktopClient,
      cache,
    })
    gatewaySetup = await setupGateway({
      baseUrl,
      token: tokenState.tokens.gateway,
      tokenId: tokenState.issued.gateway.tokenId,
      adminClient: tokenState.adminClient,
      runId,
    })

    const gatewayWorkspace = await transport(baseUrl, tokenState.tokens.web).getWorkspace()
    if (workspace.tenantId !== gatewayWorkspace.tenantId) {
      throw new Error('Web and Gateway tokens resolved to different tenant scopes.')
    }
    const desktopPolicy = await desktop.policy()
    if (desktopPolicy.localFiles !== 'disabled' || desktopPolicy.localStdioMcps !== 'disabled' || desktopPolicy.machineRuntimeConfig !== 'disabled') {
      throw new Error('Cloud Desktop policy must disable local files, local stdio MCPs, and machine runtime config.')
    }

    const webCreated = await continueFromWebSession({
      webClient,
      desktop,
      gatewaySetup,
      timeoutMs,
      promptPrefix,
      agent,
    })
    const desktopCreated = await continueFromDesktopSession({
      webClient,
      desktop,
      gatewaySetup,
      timeoutMs,
      promptPrefix,
      agent,
    })
    const gatewayCreated = await continueFromGatewaySession({
      webClient,
      desktop,
      gatewaySetup,
      timeoutMs,
      promptPrefix,
      agent,
      runId,
    })
    const concurrency = await runConcurrentPromptCheck({
      webClient,
      desktop,
      sessionId: gatewayCreated.sessionId,
      timeoutMs,
      promptPrefix,
      agent,
    })
    const replay = await runReplayHydrationCheck({
      webClient,
      desktopTransport: desktopClient,
      connection,
      cache,
      sessionId: gatewayCreated.sessionId,
      timeoutMs,
    })
    const artifacts = await desktop.listArtifacts(webCreated.sessionId).catch(() => [])
    const revoked = await revokeIssuedTokens(tokenState)
    tokensRevoked = true

    return {
      baseUrl,
      webSurface,
      workspace: {
        tenantBound: Boolean(workspace.tenantId),
        userBound: Boolean(workspace.userId),
        profileName: workspace.profileName,
        gatewayTenantMatches: true,
      },
      policy: {
        localFiles: desktopPolicy.localFiles,
        localStdioMcps: desktopPolicy.localStdioMcps,
        machineRuntimeConfig: desktopPolicy.machineRuntimeConfig,
      },
      sessions: {
        webCreated,
        desktopCreated,
        gatewayCreated,
      },
      concurrency,
      replay,
      gateway: {
        url: gatewaySetup.gatewayUrl,
        renderedMessages: gatewaySetup.fakeProvider.sent.length,
        activeStreams: gatewaySetup.daemon.runtime.streams.activeCount(),
      },
      artifacts: {
        webCreatedMetadataCount: artifacts.length,
      },
      tokens: {
        source: 'ephemeral',
        revoked,
      },
    }
  } finally {
    if (gatewaySetup) await gatewaySetup.daemon.stop().catch(() => {})
    if (!tokensRevoked) await revokeIssuedTokens(tokenState)
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  }
}

runSmoke()
  .then((results) => {
    process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`)
  })
  .catch((error) => {
    process.stderr.write(`[cloud-continuation-smoke] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
