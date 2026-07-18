import type { RouteHandler } from '../daemon-router.js'
import { z } from 'zod'
import { defineApiRouteContracts, HttpError, json, readJsonBodyAs } from '../daemon-router.js'
import { clearChannelSession, listChannelSessions, setChannelSession } from '../channel-sessions.js'
import { appendAuditEvent, getWorkTask, loadWorkState } from '../work-store.js'
import { getConfig } from '../config.js'
import { channelTargetLabel, isTrustedChannelTarget } from '../security.js'
import { listChannelCapabilities } from '../channels/capabilities.js'
import { buildChannelConnectorRegistry } from '../channel-connectors.js'
import { createChannelClaimCode } from '../channel-claims.js'
import { channelActionParityMatrix, channelActionProviderControlSummaries } from '../channel-actions.js'
import { channelControlOperatorJourneys } from '../operator-journey.js'
import { httpCallerIdentity, httpRequestSource } from './http-guardrails.js'

const zChannelProvider = z.enum(['telegram', 'whatsapp', 'discord'])
const zChannelId = z.string().min(1).max(256)
const zChannelClaimBody = z.object({
  provider: zChannelProvider,
  ttlMs: z.number().finite().positive().optional(),
  ttlSeconds: z.number().finite().positive().optional(),
}).passthrough()
const zChannelBindingBody = z.object({
  provider: zChannelProvider,
  chatId: zChannelId,
  sessionId: z.string().min(1).max(512),
  threadId: zChannelId.optional(),
  mode: z.enum(['chat', 'task', 'roadmap']).optional(),
  roadmapId: z.string().min(1).max(512).optional(),
  taskId: z.string().min(1).max(512).optional(),
  title: z.string().max(1000).optional(),
}).passthrough()
const zChannelSendBody = z.object({
  provider: zChannelProvider,
  chatId: zChannelId,
  text: z.string().min(1),
  threadId: zChannelId.optional(),
}).passthrough()
const zChannelTaskSendBody = z.object({
  taskId: z.string().min(1).max(512),
  text: z.string().min(1),
}).passthrough()
const zChannelRoadmapSendBody = z.object({
  roadmapId: z.string().min(1).max(512),
  text: z.string().min(1),
}).passthrough()
const zWhatsAppWebhookBody = z.object({
  object: z.string().optional(),
  entry: z.array(z.unknown()).optional(),
}).passthrough()
const zDiscordWebhookBody = z.record(z.string(), z.unknown())

/** @public Loaded from the built module by the API reference generator. */
export const CHANNEL_API_ROUTE_CONTRACTS = defineApiRouteContracts([
  { method: 'GET', path: '/channels/capabilities', responses: [200] },
  { method: 'GET', path: '/channels/connectors', querySchemas: { provider: zChannelProvider }, responses: [200, 404] },
  { method: 'POST', path: '/channels/claims', bodySchema: zChannelClaimBody, responses: [201, 400, 422] },
  { method: 'GET', path: '/channels/bindings', querySchemas: { provider: zChannelProvider, chatId: zChannelId, threadId: z.string().max(256), sessionId: z.string().min(1).max(512) }, responses: [200] },
  { method: 'POST', path: '/channels/bindings', bodySchema: zChannelBindingBody, responses: [200, 400, 403] },
  { method: 'DELETE', path: '/channels/bindings', requestBody: false, querySchemas: { provider: zChannelProvider, chatId: zChannelId, threadId: z.string().max(256) }, responses: [200, 400] },
  { method: 'POST', path: '/channels/send', bodySchema: zChannelSendBody, responses: [200, 400, 403, 404] },
  { method: 'POST', path: '/channels/send-to-task', bodySchema: zChannelTaskSendBody, responses: [200, 400, 404] },
  { method: 'POST', path: '/channels/send-to-roadmap', bodySchema: zChannelRoadmapSendBody, responses: [200, 400, 404] },
  { method: 'GET', path: '/webhooks/whatsapp', querySchemas: {
    'hub.mode': z.literal('subscribe'),
    'hub.verify_token': z.string().min(1),
    'hub.challenge': z.string(),
  }, responses: [200, 403] },
  { method: 'POST', path: '/webhooks/whatsapp', bodySchema: zWhatsAppWebhookBody, responses: [200, 400, 403, 503] },
  { method: 'POST', path: '/webhooks/discord', bodySchema: zDiscordWebhookBody, responses: [200, 400, 401] },
] as const)

export function channelRoutes(): RouteHandler[] {
  return [async ({ req, url, channels }) => {
    if (req.method === 'GET' && url.pathname === '/channels/capabilities') {
      const byProvider = new Map(listChannelCapabilities().map(capability => [capability.provider, capability]))
      for (const channel of channels.values()) {
        if (channel?.capabilities?.provider) byProvider.set(channel.capabilities.provider, channel.capabilities)
      }
      const nativeControlCoverage = channelActionProviderControlSummaries()
      return json({
        capabilities: [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
        actionParity: channelActionParityMatrix(),
        nativeControlCoverage,
        operatorJourneys: channelControlOperatorJourneys(nativeControlCoverage),
      })
    }

    if (req.method === 'GET' && url.pathname === '/channels/connectors') {
      const byProvider = new Map(listChannelCapabilities().map(capability => [capability.provider, capability]))
      for (const channel of channels.values()) {
        if (channel?.capabilities?.provider) byProvider.set(channel.capabilities.provider, channel.capabilities)
      }
      const registry = buildChannelConnectorRegistry({ capabilities: [...byProvider.values()] })
      const provider = url.searchParams.get('provider')
      if (!provider) return json({ connectorRegistry: registry, connectors: registry.connectors })
      const connector = registry.connectors.find(row => row.provider === provider)
      if (!connector) throw new HttpError(404, `channel connector not found: ${provider}`)
      return json({ connector })
    }

    if (req.method === 'POST' && url.pathname === '/channels/claims') {
      const body = await readJsonBodyAs(req, zChannelClaimBody)
      const provider = body.provider
      try {
        const result = createChannelClaimCode({
          provider,
          ttlMs: ttlMsFromBody(body),
          createdBy: httpCallerIdentity(req).actor,
        })
        return json({ claim: result.claim, code: result.code, instructions: result.instructions }, 201)
      } catch (err: any) {
        throw new HttpError(422, err?.message || String(err))
      }
    }

    if (req.method === 'GET' && url.pathname === '/channels/bindings') {
      const bindings = listChannelSessions({
        provider: url.searchParams.get('provider') || undefined,
        chatId: url.searchParams.get('chatId') || undefined,
        threadId: url.searchParams.has('threadId') ? url.searchParams.get('threadId') || '' : undefined,
        sessionId: url.searchParams.get('sessionId') || undefined,
      })
      return json({ bindings })
    }

    if (req.method === 'POST' && url.pathname === '/channels/bindings') {
      const body = await readJsonBodyAs(req, zChannelBindingBody)
      assertTrustedChannel(req, body.provider, body.chatId, body.threadId, 'channel.binding.upsert')
      const binding = setChannelSession(body.provider, body.chatId, body.sessionId, {
        threadId: body.threadId,
        mode: body.mode,
        roadmapId: body.roadmapId,
        taskId: body.taskId,
        title: body.title,
      })
      auditChannel(req, 'channel.binding.upsert', channelTargetLabel(binding.provider, binding.chatId, binding.threadId), 'ok')
      return json({ binding })
    }

    if (req.method === 'DELETE' && url.pathname === '/channels/bindings') {
      const provider = url.searchParams.get('provider')
      const chatId = url.searchParams.get('chatId')
      if (!provider || !chatId) throw new HttpError(400, 'provider and chatId are required')
      const threadId = url.searchParams.has('threadId') ? url.searchParams.get('threadId') || '' : undefined
      const deleted = clearChannelSession(provider, chatId, threadId)
      auditChannel(req, 'channel.binding.delete', channelTargetLabel(provider, chatId, threadId), deleted ? 'ok' : 'error')
      return json({ deleted })
    }

    if (req.method === 'POST' && url.pathname === '/channels/send') {
      const body = await readJsonBodyAs(req, zChannelSendBody)
      const provider = body.provider
      const channel = channels.get(provider)
      if (!channel?.sendMessage) throw new HttpError(404, `channel not available: ${provider}`)
      const threadId = body.threadId
      assertTrustedChannel(req, provider, body.chatId, threadId, 'channel.send')
      await channel.sendMessage(body.chatId, body.text.substring(0, 4000), { threadId })
      auditChannel(req, 'channel.send', channelTargetLabel(provider, body.chatId, threadId), 'ok')
      return json({ sent: 1 })
    }

    if (req.method === 'POST' && url.pathname === '/channels/send-to-task') {
      const body = await readJsonBodyAs(req, zChannelTaskSendBody)
      const task = getWorkTask(body.taskId)
      if (!task) throw new HttpError(404, `task not found: ${body.taskId}`)
      const targets = listChannelSessions().filter(link => link.taskId === task.id || link.roadmapId === task.roadmapId)
      const sent = await sendToChannelTargets(channels, targets, body.text)
      auditChannel(req, 'channel.send_to_task', body.taskId, 'ok', { sent, targets: targets.length })
      return json({ sent, targets: targets.length })
    }

    if (req.method === 'POST' && url.pathname === '/channels/send-to-roadmap') {
      const body = await readJsonBodyAs(req, zChannelRoadmapSendBody)
      const roadmap = loadWorkState().roadmaps.find(row => row.id === body.roadmapId)
      if (!roadmap) throw new HttpError(404, `roadmap not found: ${body.roadmapId}`)
      const targets = listChannelSessions().filter(link => link.roadmapId === roadmap.id)
      const sent = await sendToChannelTargets(channels, targets, body.text)
      auditChannel(req, 'channel.send_to_roadmap', body.roadmapId, 'ok', { sent, targets: targets.length })
      return json({ sent, targets: targets.length })
    }

    return undefined
  }]
}

function ttlMsFromBody(body: any): number | undefined {
  if (body.ttlMs !== undefined) return Number(body.ttlMs)
  if (body.ttlSeconds !== undefined) return Number(body.ttlSeconds) * 1000
  return undefined
}

async function sendToChannelTargets(channels: Map<string, any>, targets: Array<{ provider: string; chatId: string; threadId?: string }>, text: string): Promise<number> {
  const seen = new Set<string>()
  let sent = 0
  for (const target of targets) {
    const key = `${target.provider}:${target.chatId}:${target.threadId || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!isTrustedChannelTarget(target.provider, target.chatId, target.threadId, getConfig())) continue
    const channel = channels.get(target.provider)
    if (!channel?.sendMessage) continue
    await channel.sendMessage(target.chatId, text.substring(0, 4000), { threadId: target.threadId })
    sent++
  }
  return sent
}

function assertTrustedChannel(req: any, provider: string, chatId: string, threadId: string | undefined, operation: string): void {
  const target = channelTargetLabel(provider, chatId, threadId)
  if (isTrustedChannelTarget(provider, chatId, threadId, getConfig())) return
  auditChannel(req, operation, target, 'denied')
  throw new HttpError(403, `channel target is not trusted: ${target}`)
}

function auditChannel(req: any, operation: string, target: string, result: 'ok' | 'denied' | 'error', details: Record<string, unknown> = {}): void {
  try {
    const identity = httpCallerIdentity(req)
    appendAuditEvent({
      actor: identity.actor,
      source: httpRequestSource(req),
      operation,
      target,
      result,
      details: identity.claimedActor ? { ...details, claimedActor: identity.claimedActor } : details,
    })
  } catch {}
}
