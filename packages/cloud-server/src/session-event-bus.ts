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
  key: string | null
}

// Optional routing index for a fanout adapter. When a subscription's filter and
// a published event resolve to the same key, the event is delivered only to that
// key's bucket (plus the always-scanned unkeyed bucket) — turning publish from
// O(all subscribers) into O(subscribers for this key). Subscriptions or events
// with no key fall back to the scan-everything path, so routing is purely an
// optimization layered on top of `matches` (which still has the final say).
export type CloudEventFanoutKeying<EventRecord, Filter> = {
  filterKey(filter: Filter): string | null
  eventKey(event: EventRecord): string | null
}

function matches(filter: CloudSessionEventFilter, event: SessionEventRecord) {
  if (filter.tenantId && filter.tenantId !== event.tenantId) return false
  if (filter.sessionId && filter.sessionId !== event.sessionId) return false
  if (filter.afterSequence !== undefined && event.sequence <= filter.afterSequence) return false
  return true
}

const sessionEventKeying: CloudEventFanoutKeying<SessionEventRecord, CloudSessionEventFilter> = {
  filterKey: (filter) => filter.sessionId ?? null,
  eventKey: (event) => event.sessionId ?? null,
}

export class InMemoryCloudEventFanoutAdapter<EventRecord, Filter> implements CloudEventFanoutAdapter<EventRecord, Filter> {
  private readonly keyed = new Map<string, Set<Subscription<EventRecord, Filter>>>()
  private readonly unkeyed = new Set<Subscription<EventRecord, Filter>>()
  private count = 0
  private readonly matches: (filter: Filter, event: EventRecord) => boolean
  private readonly keying: CloudEventFanoutKeying<EventRecord, Filter> | null

  constructor(
    matchesEvent: (filter: Filter, event: EventRecord) => boolean,
    keying: CloudEventFanoutKeying<EventRecord, Filter> | null = null,
  ) {
    this.matches = matchesEvent
    this.keying = keying
  }

  publish(event: EventRecord) {
    const eventKey = this.keying?.eventKey(event) ?? null
    if (eventKey !== null) {
      const bucket = this.keyed.get(eventKey)
      if (bucket) this.deliver(bucket, event)
      this.deliver(this.unkeyed, event)
      return
    }
    // No routable key on the event: fall back to scanning every subscription.
    for (const bucket of this.keyed.values()) this.deliver(bucket, event)
    this.deliver(this.unkeyed, event)
  }

  private deliver(bucket: Set<Subscription<EventRecord, Filter>>, event: EventRecord) {
    for (const subscription of bucket) {
      if (!this.matches(subscription.filter, event)) continue
      subscription.listener(event)
    }
  }

  subscribe(filter: Filter, listener: (event: EventRecord) => void) {
    const key = this.keying?.filterKey(filter) ?? null
    const subscription: Subscription<EventRecord, Filter> = { filter, listener, key }
    if (key === null) {
      this.unkeyed.add(subscription)
    } else {
      let bucket = this.keyed.get(key)
      if (!bucket) {
        bucket = new Set()
        this.keyed.set(key, bucket)
      }
      bucket.add(subscription)
    }
    this.count += 1
    return () => {
      const bucket = key === null ? this.unkeyed : this.keyed.get(key)
      if (bucket?.delete(subscription)) {
        this.count -= 1
        if (key !== null && bucket.size === 0) this.keyed.delete(key)
      }
    }
  }

  get subscriberCount() {
    return this.count
  }
}

export class CloudSessionEventBus {
  private readonly fanout: CloudEventFanoutAdapter<SessionEventRecord, CloudSessionEventFilter>

  constructor(
    fanout: CloudEventFanoutAdapter<SessionEventRecord, CloudSessionEventFilter> = new InMemoryCloudEventFanoutAdapter(matches, sessionEventKeying),
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

const workspaceEventKeying: CloudEventFanoutKeying<WorkspaceEventRecord, CloudWorkspaceEventFilter> = {
  filterKey: (filter) => filter.userId ?? null,
  eventKey: (event) => event.userId ?? null,
}

export class CloudWorkspaceEventBus {
  private readonly fanout: CloudEventFanoutAdapter<WorkspaceEventRecord, CloudWorkspaceEventFilter>

  constructor(
    fanout: CloudEventFanoutAdapter<WorkspaceEventRecord, CloudWorkspaceEventFilter> = new InMemoryCloudEventFanoutAdapter(matchesWorkspaceEvent, workspaceEventKeying),
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
