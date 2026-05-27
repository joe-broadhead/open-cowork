import type { SessionEventRecord } from './control-plane-store.ts'

export type CloudSessionEventFilter = {
  tenantId?: string
  sessionId?: string
  afterSequence?: number
}

export type CloudSessionEventListener = (event: SessionEventRecord) => void

type Subscription = {
  filter: CloudSessionEventFilter
  listener: CloudSessionEventListener
}

function matches(filter: CloudSessionEventFilter, event: SessionEventRecord) {
  if (filter.tenantId && filter.tenantId !== event.tenantId) return false
  if (filter.sessionId && filter.sessionId !== event.sessionId) return false
  if (filter.afterSequence !== undefined && event.sequence <= filter.afterSequence) return false
  return true
}

export class CloudSessionEventBus {
  private readonly subscriptions = new Set<Subscription>()

  publish(event: SessionEventRecord) {
    for (const subscription of this.subscriptions) {
      if (!matches(subscription.filter, event)) continue
      subscription.listener(event)
    }
  }

  subscribe(filter: CloudSessionEventFilter, listener: CloudSessionEventListener) {
    const subscription = { filter, listener }
    this.subscriptions.add(subscription)
    return () => {
      this.subscriptions.delete(subscription)
    }
  }

  get subscriberCount() {
    return this.subscriptions.size
  }
}
