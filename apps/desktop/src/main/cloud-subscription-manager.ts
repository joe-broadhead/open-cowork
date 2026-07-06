import type {
  CloudTransportSessionEvent,
  CloudTransportSubscription,
  CloudTransportWorkspaceEvent,
} from '@open-cowork/cloud-server/transport-adapter'
import type { CloudWorkspaceSessionAdapter } from './cloud-workspace-adapter.ts'
import type { WorkspaceInfo } from '@open-cowork/shared'

// Structural mirrors of the WorkspaceGateway-local helper types so this module owns
// the cloud SSE subscription lifecycle without changing any public export.
type WorkspaceRegistration = Omit<WorkspaceInfo, 'active'>

type WorkspaceEventLike = { sender?: { id?: number } } | null | undefined

function senderKey(event: WorkspaceEventLike) {
  const id = event?.sender?.id
  return typeof id === 'number' && Number.isFinite(id) ? id : 0
}

export type CloudSubscriptionManagerDeps = {
  resolveWorkspace: (event: WorkspaceEventLike, workspaceIdInput?: string | null) => WorkspaceRegistration
  getWorkspace: (workspaceId: string) => WorkspaceRegistration | undefined
  requireCloudAdapter: (workspace: WorkspaceRegistration) => Promise<CloudWorkspaceSessionAdapter>
  reconnectBaseMs: number
  reconnectMaxMs: number
  reconnectMaxAttempts: number
}

export class CloudSubscriptionManager {
  private readonly cloudSessionSubscriptions = new Map<string, CloudTransportSubscription>()
  private readonly cloudWorkspaceSubscriptions = new Map<string, CloudTransportSubscription>()
  private readonly cloudSubscriptionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly deps: CloudSubscriptionManagerDeps

  constructor(deps: CloudSubscriptionManagerDeps) {
    this.deps = deps
  }

  async subscribeSessionEvents(
    event: WorkspaceEventLike,
    sessionId: string,
    input: {
      workspaceId?: string | null
      afterSequence?: number
      onEvent: (event: CloudTransportSessionEvent) => void
      onError?: (error: unknown) => void
    },
  ): Promise<void> {
    const workspace = this.deps.resolveWorkspace(event, input.workspaceId)
    const key = this.cloudSessionSubscriptionKey(workspace.id, sessionId)
    if (this.cloudSessionSubscriptions.has(key)) return

    let retryAttempt = 0
    let lastSequence = input.afterSequence
    const retryKey = `session:${key}`
    const subscribe = async (afterSequence?: number) => {
      const latestWorkspace = this.deps.getWorkspace(workspace.id)
      if (!latestWorkspace) return
      let adapter: CloudWorkspaceSessionAdapter
      try {
        adapter = await this.deps.requireCloudAdapter(latestWorkspace)
      } catch (error) {
        input.onError?.(error)
        this.scheduleCloudSubscriptionRetry(retryKey, key, this.cloudSessionSubscriptions, retryAttempt++, () => {
          void subscribe(lastSequence)
        })
        return
      }
      if (!adapter.subscribeSessionEvents) return
      if (this.cloudSessionSubscriptions.has(key)) return
      let subscription: CloudTransportSubscription | null = null
      let failedDuringSubscribe = false
      const onError = (error: unknown) => {
        failedDuringSubscribe = true
        if (subscription && this.cloudSessionSubscriptions.get(key) === subscription) {
          this.cloudSessionSubscriptions.delete(key)
          try { subscription.close() } catch { /* best effort */ }
        }
        input.onError?.(error)
        this.scheduleCloudSubscriptionRetry(retryKey, key, this.cloudSessionSubscriptions, retryAttempt++, () => {
          void subscribe(lastSequence)
        })
      }
      try {
        subscription = adapter.subscribeSessionEvents(sessionId, {
          afterSequence,
          onEvent: (cloudEvent) => {
            retryAttempt = 0
            lastSequence = cloudEvent.sequence
            input.onEvent(cloudEvent)
          },
          onError,
        })
      } catch (error) {
        input.onError?.(error)
        this.scheduleCloudSubscriptionRetry(retryKey, key, this.cloudSessionSubscriptions, retryAttempt++, () => {
          void subscribe(lastSequence)
        })
        return
      }
      if (failedDuringSubscribe) {
        try { subscription.close() } catch { /* best effort */ }
        return
      }
      this.clearCloudSubscriptionRetry(retryKey)
      this.cloudSessionSubscriptions.set(key, subscription)
    }
    await subscribe(input.afterSequence)
  }

  async subscribeWorkspaceEvents(
    event: WorkspaceEventLike,
    input: {
      workspaceId?: string | null
      afterSequence?: number
      onEvent: (event: CloudTransportWorkspaceEvent) => void
      onError?: (error: unknown) => void
    },
  ): Promise<void> {
    const workspace = this.deps.resolveWorkspace(event, input.workspaceId)
    const key = this.cloudWorkspaceSubscriptionKey(workspace.id, senderKey(event))
    if (this.cloudWorkspaceSubscriptions.has(key)) return

    let retryAttempt = 0
    let lastSequence = input.afterSequence
    const retryKey = `workspace:${key}`
    const subscribe = async (afterSequence?: number) => {
      const latestWorkspace = this.deps.getWorkspace(workspace.id)
      if (!latestWorkspace) return
      let adapter: CloudWorkspaceSessionAdapter
      try {
        adapter = await this.deps.requireCloudAdapter(latestWorkspace)
      } catch (error) {
        input.onError?.(error)
        this.scheduleCloudSubscriptionRetry(retryKey, key, this.cloudWorkspaceSubscriptions, retryAttempt++, () => {
          void subscribe(lastSequence)
        })
        return
      }
      if (!adapter.subscribeWorkspaceEvents) return
      if (this.cloudWorkspaceSubscriptions.has(key)) return
      let subscription: CloudTransportSubscription | null = null
      let failedDuringSubscribe = false
      const onError = (error: unknown) => {
        failedDuringSubscribe = true
        if (subscription && this.cloudWorkspaceSubscriptions.get(key) === subscription) {
          this.cloudWorkspaceSubscriptions.delete(key)
          try { subscription.close() } catch { /* best effort */ }
        }
        input.onError?.(error)
        this.scheduleCloudSubscriptionRetry(retryKey, key, this.cloudWorkspaceSubscriptions, retryAttempt++, () => {
          void subscribe(lastSequence)
        })
      }
      try {
        subscription = adapter.subscribeWorkspaceEvents({
          afterSequence,
          onEvent: (cloudEvent) => {
            retryAttempt = 0
            lastSequence = cloudEvent.sequence
            input.onEvent(cloudEvent)
          },
          onError,
        })
      } catch (error) {
        input.onError?.(error)
        this.scheduleCloudSubscriptionRetry(retryKey, key, this.cloudWorkspaceSubscriptions, retryAttempt++, () => {
          void subscribe(lastSequence)
        })
        return
      }
      if (failedDuringSubscribe) {
        try { subscription.close() } catch { /* best effort */ }
        return
      }
      this.clearCloudSubscriptionRetry(retryKey)
      this.cloudWorkspaceSubscriptions.set(key, subscription)
    }
    await subscribe(input.afterSequence)
  }

  closeForWorkspace(workspaceId: string) {
    for (const [key, timer] of this.cloudSubscriptionRetryTimers.entries()) {
      if (!key.startsWith(`session:${workspaceId}:`) && !key.startsWith(`workspace:${workspaceId}:`)) continue
      clearTimeout(timer)
      this.cloudSubscriptionRetryTimers.delete(key)
    }
    for (const [key, subscription] of this.cloudSessionSubscriptions.entries()) {
      if (!key.startsWith(`${workspaceId}:`)) continue
      try { subscription.close() } catch { /* best effort */ }
      this.cloudSessionSubscriptions.delete(key)
    }
    for (const [key, subscription] of this.cloudWorkspaceSubscriptions.entries()) {
      if (!key.startsWith(`${workspaceId}:`)) continue
      try { subscription.close() } catch { /* best effort */ }
      this.cloudWorkspaceSubscriptions.delete(key)
    }
  }

  private cloudSessionSubscriptionKey(workspaceId: string, sessionId: string) {
    return `${workspaceId}:${sessionId}`
  }

  private cloudWorkspaceSubscriptionKey(workspaceId: string, senderId: number) {
    return `${workspaceId}:${senderId}`
  }

  private cloudSubscriptionRetryDelayMs(attempt: number) {
    if (this.deps.reconnectMaxAttempts === 0) return null
    if (attempt >= this.deps.reconnectMaxAttempts) return null
    return Math.min(this.deps.reconnectMaxMs, this.deps.reconnectBaseMs * 2 ** Math.max(0, attempt))
  }

  private scheduleCloudSubscriptionRetry(
    retryKey: string,
    subscriptionKey: string,
    subscriptions: Map<string, CloudTransportSubscription>,
    attempt: number,
    retry: () => void,
  ) {
    if (subscriptions.has(subscriptionKey) || this.cloudSubscriptionRetryTimers.has(retryKey)) return
    const delay = this.cloudSubscriptionRetryDelayMs(attempt)
    if (delay === null) return
    const timer = setTimeout(() => {
      this.cloudSubscriptionRetryTimers.delete(retryKey)
      if (subscriptions.has(subscriptionKey)) return
      retry()
    }, delay)
    this.cloudSubscriptionRetryTimers.set(retryKey, timer)
  }

  private clearCloudSubscriptionRetry(retryKey: string) {
    const timer = this.cloudSubscriptionRetryTimers.get(retryKey)
    if (!timer) return
    clearTimeout(timer)
    this.cloudSubscriptionRetryTimers.delete(retryKey)
  }
}
