import type { GatewayConfig } from './config.js'
import { getConfig } from './config.js'
import { queueEvent } from './wakeup.js'
import {
  channelTargetFingerprint,
  isTrustedChannelTarget,
  redactSensitiveText,
  redactedChannelTargetLabel,
} from './security.js'
import {
  appendWorkEvent,
  listRecentWorkEvents,
  type AlertRecord,
  type WorkEventRecord,
} from './work-store.js'

export interface AlertDeliverySummary {
  attempted: number
  delivered: number
  failed: number
  deadLettered: number
  skipped: number
}

interface AlertChannel {
  sendMessage?: (chatId: string, text: string, options?: { threadId?: string; idempotencyKey?: string }) => Promise<unknown>
}

let alertDeliveryTail: Promise<void> = Promise.resolve()

export function deliverAlertNotifications(
  alerts: AlertRecord[],
  channels: Map<string, AlertChannel>,
  options: { config?: GatewayConfig; filePath?: string } = {},
): Promise<AlertDeliverySummary> {
  const run = alertDeliveryTail.then(() => deliverAlertNotificationsSerialized(alerts, channels, options))
  alertDeliveryTail = run.then(() => undefined, () => undefined)
  return run
}

async function deliverAlertNotificationsSerialized(
  alerts: AlertRecord[],
  channels: Map<string, AlertChannel>,
  options: { config?: GatewayConfig; filePath?: string },
): Promise<AlertDeliverySummary> {
  const config = options.config || getConfig()
  const delivery = config.alerts.delivery
  const summary: AlertDeliverySummary = { attempted: 0, delivered: 0, failed: 0, deadLettered: 0, skipped: 0 }
  if (!delivery.enabled || delivery.targets.length === 0) return summary

  for (const alert of alerts) {
    if (!alert.lastNotifiedAt || alert.status === 'resolved' || alert.status === 'suppressed') continue
    for (const target of delivery.targets) {
      if (!severityMeetsMinimum(alert.severity, target.minimumSeverity)) continue
      const targetKey = channelTargetFingerprint(target.provider, target.chatId, target.threadId)
      const campaign = alertDeliveryCampaign(alert)
      const since = new Date(Date.parse(alert.firstSeenAt) || 0)
      const events = targetDeliveryEvents(campaign, targetKey, since, options.filePath)
      const sent = events.some(event => event.type === 'alert.notification.sent')
      if (sent) {
        summary.skipped += 1
        continue
      }
      const failures = events.filter(event => event.type === 'alert.notification.failed').length
      const alreadyDead = events.some(event => event.type === 'alert.notification.dead_lettered')
      if (alreadyDead || failures >= delivery.maxAttempts) {
        if (!alreadyDead) appendDeliveryEvent('alert.notification.dead_lettered', campaign, alert, targetKey, { attempts: failures }, options.filePath)
        summary.deadLettered += 1
        continue
      }

      const unresolvedClaim = latestUnresolvedClaim(events)
      if (unresolvedClaim) {
        const attempts = Math.max(failures + 1, Number(unresolvedClaim.payload?.['attempts']) || 1)
        appendDeliveryEvent('alert.notification.ambiguous', campaign, alert, targetKey, {
          attempts,
          claimEventId: unresolvedClaim.id,
          reason: 'delivery outcome unknown after durable pre-send claim',
        }, options.filePath)
        appendDeliveryEvent('alert.notification.dead_lettered', campaign, alert, targetKey, {
          attempts,
          claimEventId: unresolvedClaim.id,
          reason: 'ambiguous_delivery_outcome',
        }, options.filePath)
        summary.deadLettered += 1
        queueEvent(`Alert delivery outcome is ambiguous for ${alert.id} via ${redactedChannelTargetLabel(target.provider, target.chatId, target.threadId)}; automatic retry was stopped to avoid a duplicate.`)
        continue
      }

      summary.attempted += 1
      const idempotencyKey = `${campaign}:${targetKey}`
      const claimEventId = appendDeliveryEvent('alert.notification.claimed', campaign, alert, targetKey, {
        attempts: failures + 1,
        idempotencyKey,
        state: 'claimed_before_send',
      }, options.filePath)
      try {
        if (!isTrustedChannelTarget(target.provider, target.chatId, target.threadId, config)) {
          throw new Error('configured alert target is not present in the channel allowlist')
        }
        const channel = channels.get(target.provider)
        if (!channel?.sendMessage) throw new Error(`channel provider ${target.provider} is unavailable`)
        await channel.sendMessage(target.chatId, formatAlertNotification(alert, config), {
          threadId: target.threadId,
          idempotencyKey,
        })
        appendDeliveryEvent('alert.notification.sent', campaign, alert, targetKey, { attempts: failures + 1, claimEventId, idempotencyKey }, options.filePath)
        summary.delivered += 1
      } catch (err: any) {
        const error = redactSensitiveText(err?.message || String(err), config)
        appendDeliveryEvent('alert.notification.failed', campaign, alert, targetKey, { attempts: failures + 1, claimEventId, idempotencyKey, error }, options.filePath)
        summary.failed += 1
        if (failures + 1 >= delivery.maxAttempts) {
          appendDeliveryEvent('alert.notification.dead_lettered', campaign, alert, targetKey, { attempts: failures + 1, claimEventId, error }, options.filePath)
          summary.deadLettered += 1
        }
        queueEvent(`Alert delivery failed for ${alert.id} via ${redactedChannelTargetLabel(target.provider, target.chatId, target.threadId)}: ${error}`)
      }
    }
  }
  return summary
}

function appendDeliveryEvent(
  type: string,
  campaign: string,
  alert: AlertRecord,
  targetKey: string,
  extra: Record<string, unknown>,
  filePath?: string,
): number {
  return appendWorkEvent(type, campaign, {
    alertId: alert.id,
    alertKey: alert.key,
    severity: alert.severity,
    targetKey,
    campaign: alert.lastNotifiedAt,
    ...extra,
  }, filePath)
}

function targetDeliveryEvents(campaign: string, targetKey: string, since: Date, filePath?: string): WorkEventRecord[] {
  return [
    'alert.notification.claimed',
    'alert.notification.sent',
    'alert.notification.failed',
    'alert.notification.ambiguous',
    'alert.notification.dead_lettered',
  ].flatMap(type => listRecentWorkEvents(type, campaign, since, 1000, filePath))
    .filter(event => event.payload?.['targetKey'] === targetKey)
    .sort((a, b) => a.id - b.id)
}

function latestUnresolvedClaim(events: WorkEventRecord[]): WorkEventRecord | undefined {
  const latestClaim = [...events].reverse().find(event => event.type === 'alert.notification.claimed')
  if (!latestClaim) return undefined
  const resolved = events.some(event => event.id > latestClaim.id && [
    'alert.notification.sent',
    'alert.notification.failed',
    'alert.notification.ambiguous',
    'alert.notification.dead_lettered',
  ].includes(event.type))
  return resolved ? undefined : latestClaim
}

function alertDeliveryCampaign(alert: AlertRecord): string {
  return `alert:${alert.id}:${alert.lastNotifiedAt}`
}

function severityMeetsMinimum(severity: AlertRecord['severity'], minimum: 'warning' | 'critical'): boolean {
  const rank = { info: 0, warning: 1, critical: 2 }
  return rank[severity] >= rank[minimum]
}

function formatAlertNotification(alert: AlertRecord, config: GatewayConfig): string {
  const evidence = alert.evidence.slice(0, 3).map(item => `- ${redactSensitiveText(item, config).slice(0, 500)}`)
  return [
    `[${alert.severity.toUpperCase()}] ${redactSensitiveText(alert.summary, config).slice(0, 1000)}`,
    `Source: ${redactSensitiveText(alert.source, config).slice(0, 120)}`,
    ...evidence,
    `Next action: ${redactSensitiveText(alert.nextAction, config).slice(0, 1000)}`,
  ].join('\n').slice(0, 4000)
}
