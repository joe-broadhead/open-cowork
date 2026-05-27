import type { SessionEventRecord, WorkspaceEventRecord } from './control-plane-store.ts'

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

export type CloudWorkspaceEventFilter = {
  tenantId?: string
  userId?: string
  afterSequence?: number
}

export type CloudWorkspaceEventListener = (event: WorkspaceEventRecord) => void

type WorkspaceSubscription = {
  filter: CloudWorkspaceEventFilter
  listener: CloudWorkspaceEventListener
}

function matchesWorkspaceEvent(filter: CloudWorkspaceEventFilter, event: WorkspaceEventRecord) {
  if (filter.tenantId && filter.tenantId !== event.tenantId) return false
  if (filter.userId && filter.userId !== event.userId) return false
  if (filter.afterSequence !== undefined && event.sequence <= filter.afterSequence) return false
  return true
}

export class CloudWorkspaceEventBus {
  private readonly subscriptions = new Set<WorkspaceSubscription>()

  publish(event: WorkspaceEventRecord) {
    for (const subscription of this.subscriptions) {
      if (!matchesWorkspaceEvent(subscription.filter, event)) continue
      subscription.listener(event)
    }
  }

  subscribe(filter: CloudWorkspaceEventFilter, listener: CloudWorkspaceEventListener) {
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
