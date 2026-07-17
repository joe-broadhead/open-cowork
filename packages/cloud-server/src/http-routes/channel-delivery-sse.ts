import type { IncomingMessage, ServerResponse } from 'node:http'
import { principalHasGatewayAccess } from './access-policy.ts'
import { SSE_MAX_BUFFERED_BYTES } from './sse-limits.ts'
import type { CloudHttpServerOptions } from '../http-server.ts'
import { CloudServiceError, type CloudPrincipal } from '../session-service.ts'

type RouteContext = {
  principal: CloudPrincipal
  url: URL
}

export type ChannelDeliverySseTools = {
  writeCorsHeaders(res: ServerResponse, origin: string | null | undefined): void
  writeError(res: ServerResponse, status: number, message: string, origin?: string | null): void
  trackSseStream(
    req: IncomingMessage,
    res: ServerResponse,
    options: CloudHttpServerOptions,
    cleanup: () => void,
    orgKey?: string | null,
  ): boolean
  // Enables TCP keep-alive (so the kernel reaps half-open peers) and arms a max-lifetime
  // timer on the socket, returning that timer so the caller clears it on cleanup. Mirrors
  // the session/workspace SSE routes.
  armSseSocketLifetime(req: IncomingMessage, res: ServerResponse): ReturnType<typeof setTimeout>
  ssePollMs(options: CloudHttpServerOptions): number
}

const CHANNEL_DELIVERY_SSE_EVENT_TYPE = 'channel.delivery'

function deliverySseId(delivery: unknown) {
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) return 'delivery'
  const deliveryId = (delivery as { deliveryId?: unknown }).deliveryId
  return typeof deliveryId === 'string' && deliveryId.trim() ? deliveryId : 'delivery'
}

function writeChannelDeliverySseEvent(res: ServerResponse, delivery: unknown) {
  res.write(`id: ${deliverySseId(delivery)}\n`)
  res.write(`event: ${CHANNEL_DELIVERY_SSE_EVENT_TYPE}\n`)
  res.write(`data: ${JSON.stringify({ delivery })}\n\n`)
}

export async function handleChannelDeliveriesSse(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: RouteContext,
  tools: ChannelDeliverySseTools,
) {
  if (!principalHasGatewayAccess(context.principal)) {
    tools.writeError(res, 403, 'Gateway channel access requires a gateway-scoped API token.', options.corsOrigin)
    return
  }
  tools.writeCorsHeaders(res, options.corsOrigin)
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const requestedClaimedBy = context.url.searchParams.get('claimedBy')
    || (context.principal.authSource === 'api_token' && context.principal.tokenId ? context.principal.tokenId : null)
    || context.principal.userId
    || 'gateway'
  const channelBindingIds = context.url.searchParams.getAll('channelBindingId')
    .map((value) => value.trim())
    .filter(Boolean)
  const ttlMsRaw = Number(context.url.searchParams.get('ttlMs') || 30_000)
  const ttlMs = Number.isInteger(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : 30_000
  let closed = false
  let pollActive = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  const cleanup = () => {
    if (closed) return
    closed = true
    if (pollTimer) clearInterval(pollTimer)
    if (lifetimeTimer) clearTimeout(lifetimeTimer)
  }
  if (!tools.trackSseStream(req, res, options, cleanup, context.principal.orgId || context.principal.tenantId)) return
  // Arm the same TCP keep-alive + max-lifetime guards the session/workspace SSE routes use,
  // so a half-open delivery consumer cannot pin a gateway slot indefinitely.
  lifetimeTimer = tools.armSseSocketLifetime(req, res)
  const poll = async () => {
    if (pollActive || closed || res.destroyed) return
    pollActive = true
    try {
      const requestedChannelBindingIds = channelBindingIds.length > 0 ? channelBindingIds : null
      let claimed = await options.service.domains.channels.claimNextChannelDelivery(context.principal, { claimedBy: requestedClaimedBy, ttlMs, channelBindingIds: requestedChannelBindingIds })
      while (claimed && !closed && !res.destroyed) {
        writeChannelDeliverySseEvent(res, claimed)
        // Backpressure: a consumer draining slower than deliveries are produced would
        // otherwise accumulate unbounded bytes in the writable queue (OOM). Match the
        // session/workspace SSE handlers and drop the connection past the buffer cap.
        if (res.writableLength > SSE_MAX_BUFFERED_BYTES) {
          res.destroy()
          break
        }
        claimed = await options.service.domains.channels.claimNextChannelDelivery(context.principal, { claimedBy: requestedClaimedBy, ttlMs, channelBindingIds: requestedChannelBindingIds })
      }
      if (!closed && !res.destroyed) res.write(': keep-alive\n\n')
    } catch (error) {
      if (!closed && !res.destroyed) {
        const message = error instanceof CloudServiceError
          ? error.publicMessage
          : 'Channel delivery stream failed.'
        res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`)
      }
    } finally {
      pollActive = false
    }
  }
  await poll()
  if (closed) return
  pollTimer = setInterval(() => {
    void poll()
  }, tools.ssePollMs(options))
}
