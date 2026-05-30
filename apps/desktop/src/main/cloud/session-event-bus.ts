import type { SessionEventRecord, WorkspaceEventRecord } from './control-plane-store.ts'

export type CloudSessionEventFilter = {
  tenantId?: string
  sessionId?: string
  afterSequence?: number
}

export type CloudSessionEventListener = (event: SessionEventRecord) => void

export type CloudEventFanoutSubscription = () => void

export type CloudEventFanoutAdapter<EventRecord, Filter> = {
  publish(event: EventRecord): void
  subscribe(filter: Filter, listener: (event: EventRecord) => void): CloudEventFanoutSubscription
  readonly subscriberCount: number
}

type Subscription<EventRecord, Filter> = {
  filter: Filter
  listener: (event: EventRecord) => void
}

function matches(filter: CloudSessionEventFilter, event: SessionEventRecord) {
  if (filter.tenantId && filter.tenantId !== event.tenantId) return false
  if (filter.sessionId && filter.sessionId !== event.sessionId) return false
  if (filter.afterSequence !== undefined && event.sequence <= filter.afterSequence) return false
  return true
}

export class InMemoryCloudEventFanoutAdapter<EventRecord, Filter> implements CloudEventFanoutAdapter<EventRecord, Filter> {
  private readonly subscriptions = new Set<Subscription<EventRecord, Filter>>()
  private readonly matches: (filter: Filter, event: EventRecord) => boolean

  constructor(matchesEvent: (filter: Filter, event: EventRecord) => boolean) {
    this.matches = matchesEvent
  }

  publish(event: EventRecord) {
    for (const subscription of this.subscriptions) {
      if (!this.matches(subscription.filter, event)) continue
      subscription.listener(event)
    }
  }

  subscribe(filter: Filter, listener: (event: EventRecord) => void) {
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

export class CloudSessionEventBus {
  private readonly fanout: CloudEventFanoutAdapter<SessionEventRecord, CloudSessionEventFilter>

  constructor(
    fanout: CloudEventFanoutAdapter<SessionEventRecord, CloudSessionEventFilter> = new InMemoryCloudEventFanoutAdapter(matches),
  ) {
    this.fanout = fanout
  }

  publish(event: SessionEventRecord) {
    this.fanout.publish(event)
  }

  subscribe(filter: CloudSessionEventFilter, listener: CloudSessionEventListener) {
    return this.fanout.subscribe(filter, listener)
  }

  get subscriberCount() {
    return this.fanout.subscriberCount
  }
}

export type CloudWorkspaceEventFilter = {
  tenantId?: string
  userId?: string
  afterSequence?: number
}

export type CloudWorkspaceEventListener = (event: WorkspaceEventRecord) => void

function matchesWorkspaceEvent(filter: CloudWorkspaceEventFilter, event: WorkspaceEventRecord) {
  if (filter.tenantId && filter.tenantId !== event.tenantId) return false
  if (filter.userId && filter.userId !== event.userId) return false
  if (filter.afterSequence !== undefined && event.sequence <= filter.afterSequence) return false
  return true
}

export class CloudWorkspaceEventBus {
  private readonly fanout: CloudEventFanoutAdapter<WorkspaceEventRecord, CloudWorkspaceEventFilter>

  constructor(
    fanout: CloudEventFanoutAdapter<WorkspaceEventRecord, CloudWorkspaceEventFilter> = new InMemoryCloudEventFanoutAdapter(matchesWorkspaceEvent),
  ) {
    this.fanout = fanout
  }

  publish(event: WorkspaceEventRecord) {
    this.fanout.publish(event)
  }

  subscribe(filter: CloudWorkspaceEventFilter, listener: CloudWorkspaceEventListener) {
    return this.fanout.subscribe(filter, listener)
  }

  get subscriberCount() {
    return this.fanout.subscriberCount
  }
}
