import {
  listDelegationProgressRouteReceipts,
  listRecentWorkEvents,
  listWorkEventsByType,
  type DelegationProgressRouteReceiptRecord,
  type WorkEventRecord,
} from './work-store.js'
import { filterWorkEventsByGatewaySubscription } from './gateway-events.js'

export type DelegationProgressDeliveryEventType = 'delegation.progress.notified' | 'delegation.progress.failed'

export interface DelegationProgressReadModel {
  listProgressEvents(options?: { limit?: number }): WorkEventRecord[]
  listDeliveryEvents(input: { type: DelegationProgressDeliveryEventType; dedupeKey: string; since: Date; limit?: number }): WorkEventRecord[]
  listRouteReceipts(input?: { dedupeKey?: string; progressKey?: string; idempotencyKey?: string; since?: Date; limit?: number }): DelegationProgressRouteReceiptRecord[]
}

export function createSqliteDelegationProgressReadModel(options: { filePath?: string } = {}): DelegationProgressReadModel {
  const filePath = options.filePath
  return {
    listProgressEvents(input = {}) {
      return filterWorkEventsByGatewaySubscription(
        listWorkEventsByType('delegation.progress', input.limit, filePath),
        { names: ['delegation.progress.recorded'], audience: ['channel'], order: 'asc', limit: input.limit },
      )
    },
    listDeliveryEvents(input) {
      return filterWorkEventsByGatewaySubscription(
        listRecentWorkEvents(input.type, input.dedupeKey, input.since, input.limit, filePath),
        {
          names: [input.type === 'delegation.progress.notified' ? 'delegation.progress.delivery_succeeded' : 'delegation.progress.delivery_failed'],
          subjects: [input.dedupeKey],
          since: input.since,
          audience: ['channel'],
          order: 'desc',
          limit: input.limit,
        },
      )
    },
    listRouteReceipts(input = {}) {
      return listDelegationProgressRouteReceipts(input, filePath)
    },
  }
}
