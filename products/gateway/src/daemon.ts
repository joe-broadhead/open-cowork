#!/usr/bin/env node
import * as http from 'node:http'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getConfig } from './config.js'
import { startHeartbeat, stopHeartbeat } from './heartbeat.js'
import { setDaemonClient } from './gateway-runtime.js'
import { trackWorker, loadWorkerState, reconcileWorkersFromOpenCode } from './workers.js'
import { renderDashboard } from './dashboard.js'
import { subscribeToOpenCodeEvents, addLiveClient, closeAllLiveClients, removeLiveClient } from './live.js'
import { telegramChannel } from './channels/telegram.js'
import { whatsappChannel } from './channels/whatsapp.js'
import { discordChannel } from './channels/discord.js'
import { claimInboundWebhookRateLimit, inboundWebhookRateKey, noteInboundWebhookAuthFailure } from './channels/webhook-rate-limit.js'
import { actionDeliveryForCapabilities } from './channels/capabilities.js'
import { resolveAgent } from './routing.js'
import { TransientInboundError, assertHttpBindAllowed, channelTargetFingerprint, channelTargetLabel, evaluateExposedHttpGuard, evaluateHttpRequestSecurity, exposedHttpGuardKeys, isLocalOrigin, isTransientInboundError, isTrustedChannelActor, isTrustedChannelTarget, listChannelAllowlistActorGaps, recordExposedHttpAuthResult, redactSensitiveText, redactedChannelTargetLabel, resolveHttpClientAddress } from './security.js'
import { appendChannelInboundDenialAudit } from './channel-audit.js'
import { getChannelSession, listChannelSessions, setChannelSession } from './channel-sessions.js'
import { queueEvent } from './wakeup.js'
import { startChannelSync } from './channel-sync.js'
import { adoptOrphanedRunLeases, isNotFoundError, recoverMissingOpenCodeRuns, schedulerCycle, startSchedulerAdmission, stopSchedulerAdmission, waitForSchedulerIdle } from './scheduler.js'
import { appendAuditEvent, appendWorkEvent, disposeWorkStore, listRecentWorkEvents, recoverExpiredWorkLeases, recoverInterruptedStorageRestore, reconcileWorkEnvironments, runWorkStoreRetentionMaintenance, setWorkDbLeadershipEpochProvider, upsertAlert, workStatePath } from './work-store.js'
import { channelBindingSystemContext, channelCommandMenuActions, handleChannelCommand, isChannelCommandMenuRequest, isPreTrustChannelCommandText, parseChannelCommand, type ParsedChannelCommand } from './channel-commands.js'
import { channelTargetsForOpenCodeSession, formatPermissionRequest, formatQuestionRequest, listPendingPermissions, listPendingQuestions, permissionRequestMessage, questionRequestMessage } from './opencode-requests.js'
import { HttpError, dispatchRoute, parseJsonBody, readBody, sendRouteResponse } from './daemon-router.js'
import { createJsonRoutes } from './daemon-routes/index.js'
import { deliverProjectAttention } from './attention-routing.js'
import { deliverDelegationProgress } from './delegation-progress.js'
import { deliverTeamProgressBriefings } from './team-progress.js'
import { canCurrentDaemonWrite, createDaemonLeadership, getCurrentDaemonLeadershipStatus, redactDaemonLeadershipSnapshot, setCurrentDaemonLeadership, startDaemonLeadershipHeartbeat } from './daemon-leadership.js'
import { registerDaemonShutdownHandler, removeOwnedPidFile } from './daemon-lifecycle.js'
import { rotateServiceLogIfNeeded } from './service-logs.js'
import { runAlertEngine } from './alerts.js'
import { deliverAlertNotifications } from './alert-delivery.js'
import { createLogger } from './logger.js'
import { recordAuthFailure, recordChannelMessageIn, recordChannelMessageOut, recordSchedulerCycle, startRuntimeMetricsSampler, stopRuntimeMetricsSampler } from './runtime-metrics.js'
import { createGatewayOpenCodeClient, openCodeFetch } from './opencode-client.js'
import { safeOpenCodeBaseUrlString } from './opencode-url-policy.js'
import { withDeadline } from './deadlines.js'
import { reconcilePendingSessionAdmissions } from './opencode-session-runtime.js'
import { resolveEnvironmentSpec } from './environments.js'

const log = createLogger({ component: 'gateway' })
const PORT = getConfig().httpPort
const REQUEST_NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1000
const CHANNEL_START_TIMEOUT_MS = 10_000
const requestNotificationInFlight = new Set<string>()
let progressNotificationsInFlight: Promise<unknown> | null = null
const daemonInFlightOperations = new Set<Promise<unknown>>()
type ProgressNotificationDelivery = () => Promise<unknown>

export function trackDaemonOperation<T>(operation: Promise<T>): Promise<T> {
  daemonInFlightOperations.add(operation)
  operation.then(
    () => daemonInFlightOperations.delete(operation),
    () => daemonInFlightOperations.delete(operation),
  )
  return operation
}

export async function drainDaemonOperations(): Promise<void> {
  while (daemonInFlightOperations.size > 0) {
    await Promise.allSettled([...daemonInFlightOperations])
  }
}

export async function serve() {
  // Restore recovery must be the first durable-state action. Leadership setup
  // writes into the same database and would otherwise turn a partially
  // installed generation into an apparent digest mismatch and roll it back.
  recoverInterruptedStorageRestore(path.dirname(workStatePath()))
  const config = getConfig()
  startSchedulerAdmission()
  assertHttpBindAllowed(config.security)
  const opencodeBaseUrl = safeOpenCodeBaseUrlString(config.opencodeUrl)

  // Connect to the TUI's opencode server (has all agents, MCPs, skills)
  const opencode = createGatewayOpenCodeClient({ config, opencodeUrl: opencodeBaseUrl })
  log.info('Connecting to OpenCode', { opencodeUrl: opencode.baseUrl, peer: opencode.peerName, authMode: opencode.authMode })
  const client = opencode.client
  log.info('Connected to OpenCode')

  // Export client for use by heartbeat and tools
  setDaemonClient(client)
  const leadership = createDaemonLeadership({ leaseMs: computeDaemonLeadershipLeaseMs(config) })
  setCurrentDaemonLeadership(leadership)
  const leadershipStatus = leadership.acquireOrRenew({ source: 'startup' })
  setWorkDbLeadershipEpochProvider(() => leadership.captureEpoch())
  log.info('Leadership acquired', { mode: leadershipStatus.mode, role: leadershipStatus.canWrite ? 'writer' : 'standby', instanceId: redactDaemonLeadershipSnapshot(leadershipStatus).instanceId })
  loadWorkerState()
  if (canCurrentDaemonWrite()) {
    const reconciled = await reconcileWorkersFromOpenCode(opencodeBaseUrl)
    if (reconciled > 0) log.info('Reconciled Gateway sessions', { reconciled })
    await recoverStartupState(client, config.scheduler.retryLimit)
    try {
      const actorGaps = recordChannelAllowlistActorGapAlerts(config)
      if (actorGaps > 0) log.warn('Channel allowlist rules have no trusted actors; free text from those chats is denied', { actorGaps })
    } catch (err: any) {
      queueEvent(`Channel allowlist actor-gap check failed: ${err?.message || err}`)
    }
  } else {
    log.info('Standby mode: startup recovery and scheduler writes are disabled', { remediation: leadershipStatus.remediation })
  }

  // Start the bounded, unref'd process self-metrics sampler (rss/heap/event-loop
  // lag). Cleared on shutdown below.
  startRuntimeMetricsSampler()

  // Start heartbeat for Gateway session monitoring
  startHeartbeat()

  const channelByName = new Map([
    [telegramChannel.name, telegramChannel],
    [whatsappChannel.name, whatsappChannel],
    [discordChannel.name, discordChannel],
  ])
  let acceptingWork = true
  const jsonRoutes = createJsonRoutes()
  const syncBridge = startChannelSync(client, channelByName)
  const alertEngineTimer = startAlertEngineLoop(channelByName)
  const notifyProgressOnce = () => trackDaemonOperation(canCurrentDaemonWrite() && acceptingWork
    ? notifyProgressDeliveriesOnce([
        () => deliverProjectAttention(channelByName),
        () => deliverDelegationProgress(channelByName, {}, { sessionClient: client as any }),
        () => deliverTeamProgressBriefings(channelByName, {}, { sessionClient: client as any }),
      ])
    : Promise.resolve())
  const progressTimer = setInterval(() => { notifyProgressOnce() }, 60_000)
  progressTimer.unref?.()

  // Periodic durable-store retention: prune audit ledger rows past the policy
  // window/row cap (recording the hash-chain anchor) at startup and daily.
  const runRetentionMaintenance = () => {
    if (!canCurrentDaemonWrite()) return
    try {
      const result = runWorkStoreRetentionMaintenance()
      if (result.auditLedger.pruned) queueEvent(`Retention maintenance pruned ${result.auditLedger.pruned} audit ledger row(s) past the retention policy`)
      if (result.runs.pruned) queueEvent(`Retention maintenance pruned ${result.runs.pruned} old terminal run(s) past the retention window`)
      if (result.receipts.pruned) queueEvent(`Retention maintenance pruned ${result.receipts.pruned} idle receipt row(s) past the retention window`)
    } catch (err: any) {
      queueEvent(`Retention maintenance failed: ${err?.message || err}`)
    }
  }
  // Deferred off the boot critical path: the first prune of a long-lived
  // ledger can be large, so run it a few seconds after the server is
  // listening and signal handlers are registered rather than blocking boot.
  const initialRetentionTimer = setTimeout(runRetentionMaintenance, 5000)
  initialRetentionTimer.unref?.()
  const retentionTimer = setInterval(runRetentionMaintenance, 24 * 60 * 60 * 1000)
  retentionTimer.unref?.()

  // The service log file (launchd StandardOutPath / `cli start` append) has no
  // platform rotation; rotate at boot and on a periodic size check so an
  // always-on daemon cannot grow it unbounded. Journald-managed Linux logs make
  // this a no-op unless a legacy file exists.
  const bootRotation = rotateServiceLogIfNeeded()
  if (bootRotation.rotated) log.info('Rotated service log', { file: bootRotation.file, bytes: bootRotation.size })
  const logRotationTimer = setInterval(() => {
    const rotation = rotateServiceLogIfNeeded()
    if (rotation.rotated) log.info('Rotated service log', { file: rotation.file, bytes: rotation.size })
  }, 5 * 60_000)
  logRotationTimer.unref?.()

  // Subscribe to OpenCode-native events for live dashboard, scheduler wakeups, and channel surfacing.
  let lastSchedulerWake = 0
  subscribeToOpenCodeEvents(client, (event: any) => {
    const now = Date.now()
    const wakeIntervalMs = Math.max(1000, getConfig().scheduler.intervalMs)
    if (acceptingWork && canCurrentDaemonWrite() && getConfig().scheduler.enabled && now - lastSchedulerWake >= wakeIntervalMs) {
      lastSchedulerWake = now
      recordSchedulerCycle()
      trackDaemonOperation(schedulerCycle(client).then(() => notifyProgressOnce())).catch((err: any) => queueEvent(`Scheduler event wakeup failed: ${err?.message || err}`))
    }
    // Snap channel sync back to fast polling for sessions with fresh activity.
    const props = event?.payload?.properties || event?.payload || {}
    const activitySessionId = String(props?.sessionID || props?.info?.sessionID || props?.sessionId || '')
    if (activitySessionId) syncBridge?.notifySessionActivity(activitySessionId)
    if (acceptingWork && canCurrentDaemonWrite()) {
      trackDaemonOperation(notifyOpenCodeRequest(event, channelByName).then(() => notifyProgressOnce())).catch((err: any) => queueEvent(`OpenCode request notify failed: ${err?.message || err}`))
    }
  })

  const handleChannelMessage = async (msg: any) => {
    if (!canCurrentDaemonWrite()) {
      const leadership = getCurrentDaemonLeadershipStatus()
      log.warn('Deferring channel inbound while not writer', { mode: leadership.mode, remediation: leadership.remediation, provider: msg.provider })
      throw new TransientInboundError('gateway daemon is standby; retry on the active writer')
    }
    recordChannelMessageIn(msg.provider)
    const trustDecision = channelInboundTrustDecision(msg)
    if (!trustDecision.allowed) {
      const target = redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId)
      queueEvent(trustDecision.reason === 'untrusted_actor'
        ? `Rejected untrusted channel actor inbound: ${target}`
        : `Rejected untrusted channel inbound: ${target}`)
      try { appendChannelInboundDenialAudit({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId, reason: trustDecision.reason }) } catch {}
      return
    }
    const parsedCommand = parseChannelCommand(msg.text)
    if (parsedCommand) recordChannelCommandEvent('channel.command.received', msg, parsedCommand)
    let commandFailed = false
    const commandReply = await handleChannelCommand(client as any, msg)
      .catch((err: any) => {
        commandFailed = true
        return `Command failed: ${redactSensitiveText(err?.message || String(err))}`
      })
    if (commandReply !== null) {
      const channel = channelByName.get(msg.provider)
      const actionDelivery = actionDeliveryForCapabilities(channel?.capabilities, Boolean(channel?.sendCommandMenu))
      try {
        if (parsedCommand && isChannelCommandMenuRequest(parsedCommand.name) && channel?.sendCommandMenu && actionDelivery === 'native') {
          await channel.sendCommandMenu(msg.chatId, commandReply, channelCommandMenuActions(), { threadId: msg.threadId })
          recordChannelMessageOut(msg.provider)
          recordChannelCommandEvent(commandFailed ? 'channel.command.failed' : 'channel.command.replied', msg, parsedCommand, { delivery: 'command_menu', replyLength: commandReply.length })
        } else {
          await channel?.sendMessage(msg.chatId, commandReply.substring(0, 4000), { threadId: msg.threadId })
          recordChannelMessageOut(msg.provider)
          if (parsedCommand) recordChannelCommandEvent(commandFailed ? 'channel.command.failed' : 'channel.command.replied', msg, parsedCommand, { delivery: 'message', replyLength: commandReply.length })
        }
      } catch (err: any) {
        if (parsedCommand) recordChannelCommandEvent('channel.command.failed', msg, parsedCommand, { delivery: 'message', error: redactSensitiveText(err?.message || String(err)) })
        throw err
      }
      return
    }

    const stickyPresence = (await import('./agent-presence.js')).resolveAgentPresenceForChannel(msg.provider, msg.chatId, msg.threadId)
    const agent = stickyPresence?.opencodeAgent || resolveAgent(msg.provider, msg.chatId, msg.text)
    const title = msg.provider.toUpperCase() + ':' + msg.userId + ': ' + msg.text.substring(0, 30)
    let sessionId = stickyPresence?.sessionId || getChannelSession(msg.provider, msg.chatId, msg.threadId)
    if (sessionId) {
      const sessionCheck = await checkBoundChannelSession(client, sessionId)
      if (sessionCheck === 'transient') {
        // OpenCode is briefly unreachable; keep the existing conversation binding
        // instead of silently orphaning it with a fresh session, and signal the
        // channel adapter to retry the message rather than acknowledge it.
        queueEvent(`${msg.provider} inbound deferred for ${redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId)}: bound session check failed transiently`)
        throw new TransientInboundError('bound channel session check failed transiently; OpenCode may be restarting')
      }
      if (sessionCheck === 'missing') sessionId = undefined
    }
    if (!sessionId) {
      let sessionIdCreated: string
      try {
        const { getOpenCodeSessionRuntime } = await import('./opencode-session-runtime.js')
        const created = await getOpenCodeSessionRuntime().createSession({ title: 'GW:' + title })
        sessionIdCreated = created.id
      } catch (err: any) {
        // A create failure during an OpenCode outage is transient: defer the
        // message for retry instead of dropping it. Genuine 404s stay poison.
        if (isNotFoundError(err)) throw err
        queueEvent(`${msg.provider} inbound deferred for ${redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId)}: session create failed transiently`)
        throw new TransientInboundError('channel session create failed transiently; OpenCode may be restarting')
      }
      sessionId = sessionIdCreated
      setChannelSession(msg.provider, msg.chatId, sessionId, { threadId: msg.threadId, mode: 'chat', title })
      if (stickyPresence) {
        const { updateAgentPresence } = await import('./agent-presence.js')
        updateAgentPresence(stickyPresence.presenceId, { sessionId })
      }
    }
    const binding = listChannelSessions({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId || '' })[0]
    trackWorker({ id: sessionId, title, parentId: msg.provider, status: 'running', startedAt: new Date().toISOString(), lastCheck: new Date().toISOString(), lastTodo: null, lastMessage: null })
    queueEvent(`${msg.provider} inbound message from ${channelTargetLabel(msg.provider, msg.chatId, msg.threadId)} (${msg.text.length} chars)`)
    await syncBridge?.initialize(sessionId, msg.provider, msg.chatId, msg.threadId)
    const acceptedInbound = syncBridge ? syncBridge.recordInbound(sessionId, msg.provider, msg.chatId, msg.text, msg.threadId, msg.messageId) : true
    if (!acceptedInbound) {
      queueEvent(`${msg.provider} duplicate inbound ignored for ${channelTargetLabel(msg.provider, msg.chatId, msg.threadId)}`)
      return
    }

    const system = [
      'You are responding through an OpenCode Gateway channel session. Be concise, action-oriented, and use Gateway tools for durable work state when needed.',
      channelBindingSystemContext(binding),
    ].filter(Boolean).join('\n\n')

    const { getOpenCodeSessionRuntime } = await import('./opencode-session-runtime.js')
    const runtime = getOpenCodeSessionRuntime()
    try {
      if (!syncBridge) {
        const result = await runtime.prompt({
          sessionId,
          agent,
          system,
          parts: [{ type: 'text', text: msg.text }],
          async: false,
        }) as any
        let reply = ''
        for (const p of (result?.data?.parts || [])) if (p.type === 'text' && p.text) reply += p.text + '\n'
        if (reply) await channelByName.get(msg.provider)?.sendMessage(msg.chatId, reply.substring(0, 4000), { threadId: msg.threadId })
      } else {
        await runtime.prompt({
          sessionId,
          agent,
          system,
          parts: [{ type: 'text', text: msg.text }],
        })
        syncBridge.markInboundSubmitted(msg.provider, msg.chatId, msg.text, msg.threadId, msg.messageId)
      }
    } catch (err: any) {
      syncBridge?.forgetInbound(msg.provider, msg.chatId, msg.text, msg.threadId, msg.messageId)
      const detail = redactSensitiveText(err?.message || String(err))
      queueEvent(`${msg.provider} prompt submission deferred for ${redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId)}: ${detail}`)
      throw new TransientInboundError('channel prompt submission failed transiently; retry inbound delivery')
    }
  }

  let externalChannelsStarted = false
  let externalChannelsStarting = false
  let externalChannelHandlersBound = false
  const startExternalChannelsIfWriter = async (source: string) => {
    if (externalChannelsStarted || externalChannelsStarting || !canCurrentDaemonWrite()) return
    externalChannelsStarting = true
    try {
      if (!externalChannelHandlersBound) {
        telegramChannel.onMessage(msg => trackDaemonOperation(handleChannelMessage(msg)))
        whatsappChannel.onMessage(msg => trackDaemonOperation(handleChannelMessage(msg)))
        discordChannel.onMessage(msg => trackDaemonOperation(handleChannelMessage(msg)))
        externalChannelHandlersBound = true
      }
      await startChannelAdapter(telegramChannel, source)
      await startChannelAdapter(whatsappChannel, source)
      await startChannelAdapter(discordChannel, source)
      externalChannelsStarted = true
      log.info('External channel adapters started', { source })
    } catch (err) {
      await stopExternalChannels(`${source} rollback`)
      throw err
    } finally {
      externalChannelsStarting = false
    }
  }
  const stopExternalChannels = async (source: string) => {
    if (!externalChannelsStarted && !externalChannelsStarting) return
    externalChannelsStarted = false
    externalChannelsStarting = false
    const results = await Promise.allSettled([
      Promise.resolve().then(() => telegramChannel.stop?.()),
      Promise.resolve().then(() => whatsappChannel.stop?.()),
      Promise.resolve().then(() => discordChannel.stop?.()),
    ])
    for (const result of results) {
      if (result.status === 'rejected') queueEvent(`Channel adapter stop after ${source} failed: ${redactSensitiveText(result.reason?.message || String(result.reason))}`)
    }
    log.info('External channel adapters stopped', { source })
  }

  // Start external channels only from the writer. Telegram long polling can consume
  // updates, so standby daemons stay read-only until they recover the writer lease.
  if (canCurrentDaemonWrite()) {
    void trackDaemonOperation(startExternalChannelsIfWriter('startup leadership')).catch((err: any) => {
      queueEvent(`Channel adapter startup after startup leadership failed: ${redactSensitiveText(err?.message || String(err))}`)
    })
  } else {
    log.info('Standby mode: external channel adapters were not started')
  }
  const runWriterRecovery = async (source: string) => {
    const reconciled = await reconcileWorkersFromOpenCode(opencodeBaseUrl)
    if (reconciled > 0) log.info('Reconciled Gateway sessions after recovery', { reconciled, source })
    await recoverStartupState(client, config.scheduler.retryLimit)
  }
  const leadershipTimer = startDaemonLeadershipHeartbeat(leadership, {
    onStatus: createLeadershipStatusHandler({
      initiallyWriter: canCurrentDaemonWrite(),
      runWriterRecovery: source => trackDaemonOperation(runWriterRecovery(source)).catch((err: any) => {
        queueEvent(`Writer recovery after ${source} failed: ${err?.message || err}`)
      }),
      startChannels: source => trackDaemonOperation(startExternalChannelsIfWriter(source)).catch((err: any) => {
        queueEvent(`Channel adapter startup after ${source} failed: ${err?.message || err}`)
      }),
      stopChannels: source => trackDaemonOperation(stopExternalChannels(source)).catch((err: any) => {
        queueEvent(`Channel adapter shutdown after ${source} failed: ${redactSensitiveText(err?.message || String(err))}`)
      }),
    }),
  })

  // HTTP API server
  const server = createDaemonHttpServer({ client, channels: channelByName, routes: jsonRoutes, resolvePort: () => PORT })

  server.on('error', (err: any) => {
    log.error(describeServerListenError(err, { port: PORT, host: config.security.httpHost }))
    try { leadership.release('listen-error') } catch {}
    setWorkDbLeadershipEpochProvider(undefined)
    setCurrentDaemonLeadership(null)
    removeOwnedPidFile()
    process.exit(1)
  })
  server.listen(PORT, config.security.httpHost, () => {
    log.info('Daemon listening', { url: `http://${config.security.httpHost}:${PORT}` })
  })

  // Graceful shutdown: stop admission and pollers, drain tracked work, close the
  // HTTP server, then release leadership and storage. The deadline remains a
  // final escape hatch rather than the normal shutdown path.
  let shuttingDown = false
  const shutdown = (reason: string, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    acceptingWork = false
    stopSchedulerAdmission()
    log.info('Shutting down', { reason })
    let finalized = false
    const finalize = () => {
      if (finalized) return
      finalized = true
      try { leadership.release(reason) } catch {}
      setWorkDbLeadershipEpochProvider(undefined)
      setCurrentDaemonLeadership(null)
      try { disposeWorkStore() } catch {}
      removeOwnedPidFile()
    }
    const forceExit = setTimeout(() => {
      log.error('Shutdown exceeded deadline; forcing exit', { deadlineMs: SHUTDOWN_DEADLINE_MS })
      closeAllLiveClients()
      server.closeAllConnections?.()
      finalize()
      process.exit(exitCode)
    }, SHUTDOWN_DEADLINE_MS)
    forceExit.unref?.()
    const finish = () => {
      clearTimeout(forceExit)
      finalize()
      log.info('Shutdown complete')
      process.exit(exitCode)
    }
    closeAllLiveClients()
    Promise.allSettled([
      Promise.resolve().then(() => {
        for (const timer of [alertEngineTimer, progressTimer, leadershipTimer, logRotationTimer, retentionTimer]) clearInterval(timer)
        clearTimeout(initialRetentionTimer)
        stopRuntimeMetricsSampler()
      }),
      stopHeartbeat(),
      syncBridge?.stop() || Promise.resolve(),
      waitForSchedulerIdle(),
      stopExternalChannels(reason),
      new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeIdleConnections?.()
      }),
    ]).then(() => drainDaemonOperations()).then(finish, finish)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  registerDaemonShutdownHandler(request => shutdown(request.reason, request.exitCode ?? 0))
}

export interface DaemonHttpServerInput {
  client: any
  channels: Map<string, any>
  routes: ReturnType<typeof createJsonRoutes>
  resolvePort: () => number
}

/**
 * The real daemon HTTP surface: security check before any dispatch, the 403
 * denial body, CORS origin reflection, OPTIONS handling, webhooks, SSE, and
 * JSON route dispatch. Extracted from serve() unchanged so integration tests
 * can boot the actual server on an ephemeral port; the returned server is not
 * yet listening.
 */
export function createDaemonHttpServer(input: DaemonHttpServerInput): http.Server {
  return http.createServer(async (req, res) => {
    const port = input.resolvePort()
    const url = new URL(req.url || '/', `http://localhost:${port}`)
    const security = getConfig().security
    // Exposed-mode-only abuse controls: sliding-window rate limit + auth-failure
    // lockout. Skipped entirely on the local-trusted default path so the
    // single-operator localhost flow is unchanged.
    const exposedGuardConfig = security.allowNonLocalHttp === true ? security.exposedHttp : undefined
    const clientAddress = resolveHttpClientAddress({
      remoteAddress: req.socket.remoteAddress,
      forwarded: req.headers.forwarded,
      xForwardedFor: req.headers['x-forwarded-for'],
      trustedProxyCidrs: exposedGuardConfig?.trustedProxyCidrs,
    })
    const clientKeys = exposedHttpGuardKeys(clientAddress, req.headers.authorization)
    if (exposedGuardConfig) {
      const guard = evaluateExposedHttpGuard(clientKeys, exposedGuardConfig)
      if (!guard.allowed) {
        safeAudit({ actor: 'http', source: requestSource(req), operation: `${req.method || 'GET'} ${url.pathname}`, target: url.pathname, result: 'denied', details: { reason: guard.reason, retryAfterSeconds: guard.retryAfterSeconds } })
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(guard.retryAfterSeconds) })
        return res.end(JSON.stringify({ error: `exposed HTTP request ${guard.reason}`, retryAfterSeconds: guard.retryAfterSeconds }))
      }
    }
    const decision = evaluateHttpRequestSecurity({
      host: req.headers.host,
      origin: req.headers.origin,
      remoteAddress: clientAddress,
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      authorization: req.headers.authorization,
    }, security)
    if (exposedGuardConfig) recordExposedHttpAuthResult(clientKeys, decision.allowed, exposedGuardConfig)
    if (!decision.allowed) {
      recordAuthFailure()
      safeAudit({ actor: 'http', source: requestSource(req), operation: `${req.method || 'GET'} ${url.pathname}`, target: url.pathname, result: 'denied', details: { reason: decision.reason, requiredCapability: decision.requiredCapability, grantedCapabilities: decision.grantedCapabilities } })
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: decision.reason, requiredCapability: decision.requiredCapability }))
    }

    res.setHeader('Content-Type', 'application/json')
    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
    // Reflect only local origins. A non-local Origin is never echoed back (even
    // for an authenticated non-local actor): the browser-facing consumer is the
    // same-origin dashboard, and non-browser API clients ignore CORS entirely,
    // so reflecting an arbitrary remote Origin only widens the browser attack
    // surface. Cross-origin browser access, if ever needed, is a gate-on-need
    // allowlist, not a default.
    res.setHeader('Access-Control-Allow-Origin', origin && isLocalOrigin(origin) ? origin : `http://127.0.0.1:${port}`)
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Gateway-Actor, X-Gateway-Request-Surface')
    res.setHeader('Access-Control-Max-Age', '600')
    res.setHeader('Vary', 'Origin, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      return res.end(JSON.stringify({ ok: true }))
    }

    try {
      // Web dashboard
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
        const html = await renderDashboard(url.searchParams)
        res.setHeader('Content-Type', 'text/html')
        res.writeHead(200)
        return res.end(html)
      }

      // Live SSE stream
      if (req.method === 'GET' && url.pathname === '/live/events') {
        const clientId = randomUUID()
        addLiveClient(clientId, res, origin, port)
        req.on('close', () => removeLiveClient(clientId))
        return // Don't end — keep SSE open
      }

      // Live dashboard HTML
      if (req.method === 'GET' && url.pathname === '/live') {
        res.setHeader('Content-Type', 'text/html')
        res.writeHead(200)
        return res.end(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gateway — Live View</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:1rem}
h1{color:#58a6ff;font-size:1.2rem;margin-bottom:1rem}
#events{max-height:90vh;overflow-y:auto}
.event{padding:0.5rem 0;border-bottom:1px solid #30363d;font-size:0.85rem}
.event .ts{color:#484f58;margin-right:1rem}
.event .type{color:#f0883e;font-weight:bold;margin-right:0.5rem}
.event .title{color:#58a6ff}
.event .cost{color:#3fb950;margin-left:1rem}
@keyframes pulse{50%{opacity:.6}}
.loading{animation:pulse 1s infinite;color:#484f58}
</style></head>
<body>
<h1>🔴 LIVE — Gateway Events</h1>
<div id="events"><div class="loading">Waiting for events...</div></div>
<script>
const ev = new EventSource('/live/events')
function prependEvent(parts) {
  const el = document.getElementById('events')
  const div = document.createElement('div')
  div.className = 'event'
  for (const part of parts) {
    const span = document.createElement('span')
    if (part.className) span.className = part.className
    span.textContent = part.text || ''
    div.appendChild(span)
  }
  el.insertBefore(div, el.firstChild)
  if (el.children.length > 100) el.removeChild(el.lastChild)
}
ev.onmessage = (e) => {
  const d = JSON.parse(e.data)
  if (d.type === 'connected') {
    prependEvent([{ className: 'type', text: '● Connected' }])
    return
  }
  const ts = d.updated ? new Date(d.updated).toLocaleTimeString() : '--'
  const cost = d.cost ? ' $' + d.cost.toFixed(4) : ''
  const tokens = d.tokens ? ' (' + ((d.tokens.input || 0) + (d.tokens.output || 0)).toLocaleString() + ' tok)' : ''
  prependEvent([
    { className: 'ts', text: ts },
    { className: 'type', text: '[' + (d.type || '?') + ']' },
    { className: 'title', text: d.title || 'Connected' },
    { className: 'cost', text: cost + tokens },
  ])
}
ev.onerror = () => {
  const el = document.getElementById('events')
  if (!el.textContent.includes('Reconnecting')) {
    prependEvent([{ text: '⚠ Reconnecting...' }])
  }
}
</script>
</body></html>`)
      }

      if (req.method === 'GET' && url.pathname === '/webhooks/whatsapp') {
        const rateKey = inboundWebhookRateKey('whatsapp', req)
        const rate = claimInboundWebhookRateLimit(rateKey)
        if (!rate.ok) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))))
          res.writeHead(429)
          return res.end(JSON.stringify({ error: 'whatsapp webhook rate limited' }))
        }
        const challenge = whatsappChannel.verifyWebhook(url)
        if (challenge === null) {
          noteInboundWebhookAuthFailure(rateKey)
          res.writeHead(403)
          return res.end(JSON.stringify({ error: 'invalid whatsapp verify token' }))
        }
        res.setHeader('Content-Type', 'text/plain')
        res.writeHead(200)
        return res.end(challenge)
      }

      if (req.method === 'POST' && url.pathname === '/webhooks/whatsapp') {
        if (!canCurrentDaemonWrite()) return sendStandbyWebhookResponse(res)
        const rateKey = inboundWebhookRateKey('whatsapp', req)
        const rate = claimInboundWebhookRateLimit(rateKey)
        if (!rate.ok) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))))
          res.writeHead(429)
          return res.end(JSON.stringify({ error: 'whatsapp webhook rate limited' }))
        }
        const body = await readBody(req)
        if (!whatsappChannel.verifySignature(req.headers['x-hub-signature-256'], body)) {
          noteInboundWebhookAuthFailure(rateKey)
          res.writeHead(403)
          return res.end(JSON.stringify({ error: 'invalid whatsapp signature' }))
        }
        let count: number
        try {
          count = await whatsappChannel.handleWebhook(parseJsonBody(body))
        } catch (err: any) {
          if (!isTransientInboundError(err)) throw err
          // Do not acknowledge a transiently failed inbound (e.g. OpenCode is
          // restarting): a non-2xx status makes Meta retry the webhook delivery.
          res.writeHead(503)
          return res.end(JSON.stringify({ error: 'transient inbound failure; retry delivery' }))
        }
        res.writeHead(200)
        return res.end(JSON.stringify({ ok: true, messages: count }))
      }

      if (req.method === 'POST' && url.pathname === '/webhooks/discord') {
        if (!canCurrentDaemonWrite()) return sendStandbyWebhookResponse(res)
        const rateKey = inboundWebhookRateKey('discord', req)
        const rate = claimInboundWebhookRateLimit(rateKey)
        if (!rate.ok) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))))
          res.writeHead(429)
          return res.end(JSON.stringify({ error: 'discord webhook rate limited' }))
        }
        const body = await readBody(req)
        const response = await discordChannel.handleInteraction(body, {
          'x-signature-ed25519': req.headers['x-signature-ed25519'],
          'x-signature-timestamp': req.headers['x-signature-timestamp'],
        })
        if (response.status === 401) noteInboundWebhookAuthFailure(rateKey)
        res.writeHead(response.status)
        return res.end(JSON.stringify(response.body))
      }

      const routeResponse = await dispatchRoute(input.routes, { req, url, client: input.client, channels: input.channels })
      if (routeResponse) return sendRouteResponse(res, routeResponse)

      res.writeHead(404)
      res.end(JSON.stringify({ error: 'not found' }))
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500
      res.writeHead(status)
      const message = e instanceof HttpError ? redactSensitiveText(e?.message || 'Request failed') : 'Internal error'
      res.end(JSON.stringify({ error: message }))
    }
  })
}

const SHUTDOWN_DEADLINE_MS = 30_000
const DAEMON_LEADERSHIP_MIN_LEASE_MS = 30_000
const DAEMON_LEADERSHIP_PREPARE_BUFFER_MS = 30_000

export function computeDaemonLeadershipLeaseMs(config: Pick<ReturnType<typeof getConfig>, 'scheduler' | 'environments'>): number {
  const schedulerFloor = Math.max(config.scheduler.intervalMs * 3, DAEMON_LEADERSHIP_MIN_LEASE_MS)
  const prepareTimeoutFloor = maxConfiguredEnvironmentPrepareTimeoutMs(config)
  return Math.max(schedulerFloor, prepareTimeoutFloor > 0 ? prepareTimeoutFloor + Math.max(config.scheduler.intervalMs * 3, DAEMON_LEADERSHIP_PREPARE_BUFFER_MS) : 0)
}

function maxConfiguredEnvironmentPrepareTimeoutMs(config: Pick<ReturnType<typeof getConfig>, 'environments'>): number {
  const names = new Set([config.environments.defaultEnvironment, ...Object.keys(config.environments.environments || {})])
  let maxTimeoutMs = 0
  for (const name of names) {
    const resolved = resolveEnvironmentSpec({ taskEnvironment: name, config: config.environments, stage: 'implement' })
    if (resolved.ok) maxTimeoutMs = Math.max(maxTimeoutMs, resolved.spec.resources.timeoutMs)
  }
  return maxTimeoutMs
}

/**
 * Once a daemon holds the writer lease, promotion from standby must run the same
 * recovery pass as boot-as-writer (lease adoption, expired-lease and orphan
 * recovery, environment reconciliation) — not just start channel adapters.
 */
export function createLeadershipStatusHandler(input: {
  initiallyWriter: boolean
  runWriterRecovery: (source: string) => unknown
  startChannels: (source: string) => unknown
  stopChannels: (source: string) => unknown
}): (snapshot: { canWrite: boolean }) => void {
  let writerRecoveryArmed = !input.initiallyWriter
  return snapshot => {
    if (!snapshot.canWrite) {
      if (!writerRecoveryArmed) input.stopChannels('leadership lost')
      writerRecoveryArmed = true
      return
    }
    if (writerRecoveryArmed) {
      writerRecoveryArmed = false
      input.runWriterRecovery('leadership recovery')
    }
    input.startChannels('leadership recovery')
  }
}

export function describeServerListenError(err: any, input: { port: number; host: string }): string {
  const address = `http://${input.host}:${input.port}`
  if (err?.code === 'EADDRINUSE') {
    return [
      `[gateway] Failed to listen on ${address}: the port is already in use (EADDRINUSE).`,
      `Another Gateway daemon or app likely owns port ${input.port}.`,
      'Run `opencode-gateway status` to check for a running daemon, `opencode-gateway stop` to stop it, or change `httpPort` in the Gateway config, then start again.',
    ].join(' ')
  }
  if (err?.code === 'EACCES') {
    return `[gateway] Failed to listen on ${address}: permission denied (EACCES). Choose an unprivileged port (>1024) via \`httpPort\` in the Gateway config.`
  }
  return `[gateway] HTTP server error on ${address}: ${redactSensitiveText(err?.message || String(err))}`
}

export async function checkBoundChannelSession(client: any, sessionId: string): Promise<'usable' | 'missing' | 'transient'> {
  try {
    await client.session.get({ path: { id: sessionId } })
    return 'usable'
  } catch (err: any) {
    return isNotFoundError(err) ? 'missing' : 'transient'
  }
}

function startAlertEngineLoop(channels: Map<string, any>, intervalMs = 60_000): NodeJS.Timeout {
  const run = async () => {
    if (!canCurrentDaemonWrite()) return
    const opencodeReachable = await checkOpenCodeReachable().catch(() => false)
    const result = await runAlertEngine({ opencodeReachable })
    await deliverAlertNotifications(result.active, channels)
  }
  const timer = setInterval(() => {
    trackDaemonOperation(run()).catch((err: any) => queueEvent(`Alert engine failed: ${redactSensitiveText(err?.message || String(err))}`))
  }, Math.max(10_000, intervalMs))
  timer.unref?.()
  trackDaemonOperation(run()).catch((err: any) => queueEvent(`Alert engine failed: ${redactSensitiveText(err?.message || String(err))}`))
  return timer
}

async function checkOpenCodeReachable(): Promise<boolean> {
  try {
    const res = await openCodeFetch(getConfig().opencodeUrl, 'global/health', {}, { timeoutMs: 2000 })
    return res.ok
  } catch {
    return false
  }
}

async function startChannelAdapter(channel: { name: string; start: () => Promise<void> }, source: string): Promise<void> {
  await withDeadline(Promise.resolve().then(() => channel.start()), CHANNEL_START_TIMEOUT_MS, `${channel.name} channel start (${source})`)
}

function requestSource(req: http.IncomingMessage): string {
  return `${req.socket.remoteAddress || 'unknown'} host=${redactSensitiveText(String(req.headers.host || 'unknown'))}`
}

function sendStandbyWebhookResponse(res: http.ServerResponse): void {
  const leadership = redactDaemonLeadershipSnapshot(getCurrentDaemonLeadershipStatus())
  res.writeHead(409, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    error: 'gateway daemon is standby; writer ownership is required for channel ingress',
    leadership,
  }))
}

function safeAudit(input: Parameters<typeof appendAuditEvent>[0]): void {
  try { appendAuditEvent(input) } catch {}
}

async function recoverStartupState(client: any, retryLimit: number): Promise<void> {
  if (!canCurrentDaemonWrite()) return
  // Adopt live run leases dispatched by a previous daemon instance before expiry
  // recovery runs, so completed predecessor work is harvested instead of discarded.
  const adopted = adoptOrphanedRunLeases()
  if (adopted.adopted) queueEvent(`Startup adopted ${adopted.adopted} in-flight run lease(s) from a previous daemon instance`)
  const expired = recoverExpiredWorkLeases(retryLimit)
  if (expired.recovered || expired.blocked) queueEvent(`Startup recovered ${expired.recovered} expired lease(s), blocked ${expired.blocked}`)
  const environments = reconcileWorkEnvironments()
  if (environments.cleanupFailed || environments.retained) queueEvent(`Startup environment reconciliation checked ${environments.checked} environment(s), retained ${environments.retained}, cleanup failed ${environments.cleanupFailed}`)
  try {
    const admissions = await reconcilePendingSessionAdmissions()
    if (admissions.cleaned || admissions.retained) queueEvent(`Startup session-admission reconciliation checked ${admissions.checked} intent(s), cleaned ${admissions.cleaned}, retained ${admissions.retained}`)
  } catch (err: any) {
    queueEvent(`Startup session-admission reconciliation skipped: ${err?.message || err}`)
  }
  try {
    const orphaned = await recoverMissingOpenCodeRuns(client, undefined, retryLimit)
    if (orphaned.recovered || orphaned.blocked) queueEvent(`Startup recovered ${orphaned.recovered} orphaned run(s), blocked ${orphaned.blocked}`)
  } catch (err: any) {
    queueEvent(`Startup orphan recovery skipped: ${err?.message || err}`)
  }
}

export async function notifyOpenCodeRequest(event: any, channels: Map<string, any>): Promise<void> {
  const type = String(event?.type || '')
  if (!['question.asked', 'question.v2.asked', 'permission.asked', 'permission.v2.asked'].includes(type)) return
  const props = event?.payload?.properties || event?.payload || {}
  const sessionId = String(props.sessionID || '')
  if (!sessionId) return
  const targets = channelTargetsForOpenCodeSession(sessionId)
  if (targets.length === 0) return

  let text = ''
  let message: any
  let subjectId = ''
  const kind = type.startsWith('question.') ? 'question' : 'permission'
  if (type.startsWith('question.')) {
    const row = props.id && props.questions ? props : (await listPendingQuestions()).find(q => q.sessionID === sessionId)
    if (!row) return
    subjectId = `question:${row.id}`
    text = formatQuestionRequest(row)
    message = questionRequestMessage(row)
  } else {
    const row = props.id && props.permission ? props : (await listPendingPermissions()).find(p => p.sessionID === sessionId)
    if (!row) return
    subjectId = `permission:${row.id}`
    text = formatPermissionRequest(row)
    message = permissionRequestMessage(row)
  }

  for (const target of targets) {
    const targetKey = redactedChannelTargetLabel(target.provider, target.chatId, target.threadId)
    if (wasOpenCodeRequestNotified(subjectId, targetKey)) continue
    const channel = channels.get(target.provider)
    if (!channel?.sendMessage && !channel?.sendStructuredMessage) continue
    const inFlightKey = `${subjectId}:${targetKey}`
    if (requestNotificationInFlight.has(inFlightKey)) continue
    requestNotificationInFlight.add(inFlightKey)
    try {
      if (wasOpenCodeRequestNotified(subjectId, targetKey)) continue
      if (channel.sendStructuredMessage) await channel.sendStructuredMessage(target.chatId, message, { threadId: target.threadId })
      else await channel.sendMessage(target.chatId, text.substring(0, 4000), { threadId: target.threadId })
      appendWorkEvent('opencode.request.notified', subjectId, { kind, sessionId, targetKey, provider: target.provider })
    } catch (err: any) {
      const error = redactSensitiveText(err?.message || String(err))
      appendWorkEvent('opencode.request.notify_failed', subjectId, { kind, sessionId, targetKey, provider: target.provider, error })
      upsertAlert({ key: `opencode-request:${kind}:${targetKey}`, severity: 'warning', source: 'opencode.requests', target: subjectId, summary: `OpenCode ${kind} notification delivery failed`, evidence: [target.provider || 'unknown', error], nextAction: 'Check channel credentials, allowlists, and OpenCode request routing.' })
      queueEvent(`OpenCode ${kind} notification failed for ${subjectId} via ${target.provider}: ${error}`)
    } finally {
      requestNotificationInFlight.delete(inFlightKey)
    }
  }
}

function wasOpenCodeRequestNotified(subjectId: string, targetKey: string): boolean {
  const since = new Date(Date.now() - REQUEST_NOTIFICATION_TTL_MS)
  return listRecentWorkEvents('opencode.request.notified', subjectId, since)
    .some(event => event.payload?.['targetKey'] === targetKey)
}

export function notifyProgressDeliveriesOnce(deliveries: ProgressNotificationDelivery[]): Promise<unknown> {
  if (progressNotificationsInFlight) return progressNotificationsInFlight
  progressNotificationsInFlight = Promise.allSettled(deliveries.map(delivery => Promise.resolve().then(delivery)))
    .then(results => {
      for (const result of results) {
        if (result.status === 'rejected') queueEvent(`Progress notify failed: ${redactSensitiveText(result.reason?.message || String(result.reason))}`)
      }
    })
    .finally(() => { progressNotificationsInFlight = null })
  return progressNotificationsInFlight
}

export type ChannelInboundTrustDenialReason = 'untrusted_target' | 'untrusted_actor'

export interface ChannelInboundTrustDecision {
  allowed: boolean
  reason?: ChannelInboundTrustDenialReason
}

export function channelInboundTrustDecision(msg: { provider: string; chatId: string; threadId?: string; userId?: string; text?: string }): ChannelInboundTrustDecision {
  const text = String(msg.text || '')
  if (isPreTrustChannelCommandText(text)) return { allowed: true }
  if (!isTrustedChannelTarget(msg.provider, msg.chatId, msg.threadId, getConfig())) return { allowed: false, reason: 'untrusted_target' }
  // Slash commands stay target-gated here; privileged commands run the per-sender
  // actor preflight in channel-commands before any state mutation.
  if (parseChannelCommand(text)) return { allowed: true }
  // Free text is forwarded verbatim as an agent prompt, so it requires a trusted
  // actor, not just a trusted target (see security.trustTargetMembersForFreeText).
  const actor = isTrustedChannelActor({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId, userId: msg.userId, privileged: false }, getConfig())
  return actor.allowed ? { allowed: true } : { allowed: false, reason: 'untrusted_actor' }
}

/**
 * Raises a warning alert for every allowlist rule that the default-strict
 * per-sender free-text gate has stranded: no userIds/adminUserIds and no
 * private-chat fallback (Discord rules; group-shaped Telegram chats). The alert
 * names both remediations so operators are not locked out silently.
 */
function recordChannelAllowlistActorGapAlerts(config = getConfig()): number {
  const gaps = listChannelAllowlistActorGaps(config)
  for (const gap of gaps) {
    upsertAlert({
      key: `channel-allowlist-actor-gap:${gap.target}`,
      severity: 'warning',
      source: 'security.channel_allowlists',
      target: gap.target,
      summary: `Channel allowlist rule ${gap.target} has no trusted actors; free text from this ${gap.provider} chat is denied`,
      evidence: [gap.provider, gap.reason],
      nextAction: 'Re-run the channel claim flow from that chat (create a claim code and send it from the affected chat) to record the sender as a trusted actor, or set security.trustTargetMembersForFreeText=true to trust all members of trusted targets for free text.',
    })
  }
  return gaps.length
}

function recordChannelCommandEvent(type: string, msg: any, command: ParsedChannelCommand, extra: Record<string, unknown> = {}): void {
  const target = redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId)
  const messageKey = msg.messageId ? channelTargetFingerprint(msg.provider, msg.messageId, msg.threadId) : undefined
  appendWorkEvent(type, `${msg.provider}:${command.name}`, {
    provider: msg.provider,
    command: command.name,
    target,
    messageKey,
    thread: msg.threadId ? 'present' : 'none',
    ...extra,
  })
}

export const __daemonTest = { parseJsonBody, readBody, notifyProgressDeliveriesOnce, trackDaemonOperation, drainDaemonOperations, channelInboundTrustDecision, recordChannelCommandEvent, recordChannelAllowlistActorGapAlerts }

// Run directly if started as main
if (process.argv[1]?.includes('daemon.js') || process.argv[1]?.includes('daemon.ts')) {
  serve().catch(err => {
    log.error('Fatal daemon error', { error: err?.message || String(err) })
    process.exit(1)
  })
}
