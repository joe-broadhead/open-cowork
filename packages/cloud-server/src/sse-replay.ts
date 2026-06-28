import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

type SequencedSseEvent = { sequence: number }

type SseReplaySubscriber = {
  lastSequence: number
  listener: (event: SequencedSseEvent) => void
  onError?: (error: unknown) => void
}

type SseReplayTopic = {
  subscribers: Set<SseReplaySubscriber>
  // Loaders may resolve synchronously (in-memory store) or asynchronously
  // (postgres store); the poll loop awaits the result, so both are accepted.
  loadEvents: (afterSequence: number) => SequencedSseEvent[] | Promise<SequencedSseEvent[]>
  lastSequence: number
  polling: boolean
  pollRequested: boolean
  // When loadEvents is bounded (returns at most batchSize events), a full batch means
  // more may be pending, so the topic re-polls immediately to drain the backlog instead
  // of waiting a full pollMs per page. 0 = unbounded loadEvents (no immediate re-poll).
  batchSize: number
  timer: ReturnType<typeof setInterval>
}

type ActiveSseStream = {
  res: ServerResponse
  socket: Socket | null
  orgKey: string | null
  close: () => void
}

type SseStreamScope = {
  // Per-org concurrent-connection cap. A single org could otherwise open thousands of
  // long-lived SSE connections within its request-rate budget (each holding a socket,
  // timers, a bus subscription, and a DB poll). 0/undefined ⇒ no cap.
  orgKey?: string
  maxPerOrg?: number
}

export class CloudSseStreamRegistry {
  private readonly streams = new Set<ActiveSseStream>()
  private readonly perOrgCounts = new Map<string, number>()
  private closing = false

  track(req: IncomingMessage, res: ServerResponse, cleanup: () => void, scope: SseStreamScope = {}) {
    if (this.closing) {
      const socket = res.socket || req.socket || null
      cleanup()
      if (!res.writableEnded && !res.destroyed) res.end()
      if (!res.destroyed) res.destroy()
      if (socket && !socket.destroyed) socket.destroy()
      return false
    }

    const orgKey = scope.orgKey || null
    if (orgKey && scope.maxPerOrg && scope.maxPerOrg > 0 && (this.perOrgCounts.get(orgKey) || 0) >= scope.maxPerOrg) {
      // Over the per-org cap. Headers are already sent (SSE 200) by the time we get here,
      // so signal via an SSE error event then drop the connection.
      const socket = res.socket || req.socket || null
      cleanup()
      if (!res.writableEnded && !res.destroyed) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'Too many concurrent streams for this organization.' })}\n\n`)
        res.end()
      }
      if (!res.destroyed) res.destroy()
      if (socket && !socket.destroyed) socket.destroy()
      return false
    }

    let closed = false
    const stream: ActiveSseStream = {
      res,
      socket: res.socket || req.socket || null,
      orgKey,
      close: () => {
        if (closed) return
        closed = true
        this.streams.delete(stream)
        if (orgKey) {
          const next = (this.perOrgCounts.get(orgKey) || 1) - 1
          if (next <= 0) this.perOrgCounts.delete(orgKey)
          else this.perOrgCounts.set(orgKey, next)
        }
        req.off('close', stream.close)
        res.off('close', stream.close)
        res.off('finish', stream.close)
        cleanup()
      },
    }
    this.streams.add(stream)
    if (orgKey) this.perOrgCounts.set(orgKey, (this.perOrgCounts.get(orgKey) || 0) + 1)
    req.once('close', stream.close)
    res.once('close', stream.close)
    res.once('finish', stream.close)
    return true
  }

  closeAll() {
    this.closing = true
    for (const stream of Array.from(this.streams)) {
      stream.close()
      if (!stream.res.writableEnded && !stream.res.destroyed) stream.res.end()
      if (!stream.res.destroyed) stream.res.destroy()
      if (stream.socket && !stream.socket.destroyed) stream.socket.destroy()
    }
  }
}

export class CloudSseReplayHub {
  private readonly topics = new Map<string, SseReplayTopic>()
  private closed = false

  subscribe(
    input: {
      key: string
      afterSequence: number
      pollMs: number
      loadEvents: (afterSequence: number) => SequencedSseEvent[] | Promise<SequencedSseEvent[]>
      listener: (event: SequencedSseEvent) => void
      onError?: (error: unknown) => void
      batchSize?: number
    },
  ) {
    if (this.closed) return () => {}
    let topic = this.topics.get(input.key)
    if (!topic) {
      topic = {
        subscribers: new Set(),
        loadEvents: input.loadEvents,
        lastSequence: input.afterSequence,
        polling: false,
        pollRequested: false,
        batchSize: Number.isInteger(input.batchSize) && (input.batchSize as number) > 0 ? (input.batchSize as number) : 0,
        timer: setInterval(() => {
          this.requestPoll(input.key)
        }, input.pollMs),
      }
      this.topics.set(input.key, topic)
    }
    const subscriber: SseReplaySubscriber = {
      lastSequence: input.afterSequence,
      listener: input.listener,
      onError: input.onError,
    }
    topic.subscribers.add(subscriber)
    this.requestPoll(input.key)
    return () => {
      const current = this.topics.get(input.key)
      if (!current) return
      current.subscribers.delete(subscriber)
      if (current.subscribers.size > 0) return
      clearInterval(current.timer)
      this.topics.delete(input.key)
    }
  }

  get topicCount() {
    return this.topics.size
  }

  close() {
    this.closed = true
    for (const topic of this.topics.values()) {
      clearInterval(topic.timer)
      topic.subscribers.clear()
    }
    this.topics.clear()
  }

  private requestPoll(key: string) {
    if (this.closed) return
    const topic = this.topics.get(key)
    if (!topic) return
    if (topic.polling) {
      topic.pollRequested = true
      return
    }
    void this.poll(key)
  }

  private replayAfterSequence(topic: SseReplayTopic) {
    let afterSequence = topic.lastSequence
    for (const subscriber of topic.subscribers) {
      afterSequence = Math.min(afterSequence, subscriber.lastSequence)
    }
    return afterSequence
  }

  private async poll(key: string) {
    if (this.closed) return
    const topic = this.topics.get(key)
    if (!topic || topic.polling) return
    topic.polling = true
    topic.pollRequested = false
    try {
      const afterSequence = this.replayAfterSequence(topic)
      const events = await topic.loadEvents(afterSequence)
      if (this.closed || this.topics.get(key) !== topic) return
      // A full bounded batch means more events may be pending — drain immediately.
      if (topic.batchSize > 0 && events.length >= topic.batchSize) topic.pollRequested = true
      for (const event of events) {
        if (event.sequence <= afterSequence) continue
        topic.lastSequence = Math.max(topic.lastSequence, event.sequence)
        for (const subscriber of topic.subscribers) {
          if (subscriber.lastSequence < afterSequence) {
            topic.pollRequested = true
            continue
          }
          if (event.sequence <= subscriber.lastSequence) continue
          subscriber.listener(event)
          subscriber.lastSequence = event.sequence
        }
      }
    } catch (error) {
      for (const subscriber of topic.subscribers) subscriber.onError?.(error)
    } finally {
      if (this.topics.get(key) === topic) {
        topic.polling = false
        if (topic.pollRequested && topic.subscribers.size > 0) {
          topic.pollRequested = false
          this.requestPoll(key)
        }
      }
    }
  }
}
