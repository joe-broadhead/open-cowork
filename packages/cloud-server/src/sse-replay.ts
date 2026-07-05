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
  // Optional coarse key shared by every topic that a single Postgres NOTIFY should wake
  // (see wake()). null ⇒ this topic is poll-only and not addressable by NOTIFY.
  wakeKey: string | null
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
  // wakeKey -> set of topic keys sharing it. A single Postgres NOTIFY targets a coarse
  // wakeKey (tenant/session or tenant/user) and wakes every topic registered under it,
  // which for sessions can be multiple per-subscriber topics. Pure index over the topics
  // map; the topic's own key still owns delivery.
  private readonly wakeIndex = new Map<string, Set<string>>()
  // When set (> 0), NOTIFY-addressable topics (those registered with a wakeKey) poll at
  // this longer backstop cadence instead of their requested pollMs: the LISTEN/NOTIFY
  // accelerator's wake() drives low-latency delivery, so the interval poll only has to
  // catch missed notifications. Topics WITHOUT a wakeKey have no other trigger and keep
  // their requested pollMs. null (the default constructor, and every hub built when the
  // accelerator is off) leaves all topics on their requested pollMs — unchanged behaviour.
  private readonly wakeBackstopPollMs: number | null
  private closed = false

  constructor(options: { wakeBackstopPollMs?: number } = {}) {
    this.wakeBackstopPollMs = typeof options.wakeBackstopPollMs === 'number'
      && Number.isFinite(options.wakeBackstopPollMs)
      && options.wakeBackstopPollMs > 0
      ? options.wakeBackstopPollMs
      : null
  }

  subscribe(
    input: {
      key: string
      afterSequence: number
      pollMs: number
      loadEvents: (afterSequence: number) => SequencedSseEvent[] | Promise<SequencedSseEvent[]>
      listener: (event: SequencedSseEvent) => void
      onError?: (error: unknown) => void
      batchSize?: number
      // Coarse key for the Postgres LISTEN/NOTIFY accelerator (see wake()). When omitted
      // the topic stays poll-only; NOTIFY cannot address it. Pure optimisation — the poll
      // loop is unaffected either way.
      wakeKey?: string
    },
  ) {
    if (this.closed) return () => {}
    let topic = this.topics.get(input.key)
    if (!topic) {
      const wakeKey = input.wakeKey ?? null
      // NOTIFY-accelerated hubs stretch wake-addressable topics to the backstop cadence.
      // Math.max so an operator-requested interval longer than the backstop is never shortened.
      const pollMs = wakeKey && this.wakeBackstopPollMs !== null
        ? Math.max(input.pollMs, this.wakeBackstopPollMs)
        : input.pollMs
      topic = {
        subscribers: new Set(),
        loadEvents: input.loadEvents,
        lastSequence: input.afterSequence,
        polling: false,
        pollRequested: false,
        batchSize: Number.isInteger(input.batchSize) && (input.batchSize as number) > 0 ? (input.batchSize as number) : 0,
        timer: setInterval(() => {
          this.requestPoll(input.key)
        }, pollMs),
        wakeKey,
      }
      this.topics.set(input.key, topic)
      if (topic.wakeKey) {
        let bucket = this.wakeIndex.get(topic.wakeKey)
        if (!bucket) {
          bucket = new Set()
          this.wakeIndex.set(topic.wakeKey, bucket)
        }
        bucket.add(input.key)
      }
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
      this.unindexWakeKey(current.wakeKey, input.key)
    }
  }

  get topicCount() {
    return this.topics.size
  }

  // Trigger an immediate read for every topic registered under wakeKey. This is the
  // Postgres LISTEN/NOTIFY accelerator's only entry point: it just calls requestPoll(),
  // i.e. an EARLIER run of the topic's existing loadEvents (*ForStream) read. It never
  // delivers events itself and never bypasses the poll loop, so a missed wake is caught
  // by the next poll and a duplicate wake is a harmless no-op. Safe to call at any time.
  wake(wakeKey: string) {
    if (this.closed) return
    const keys = this.wakeIndex.get(wakeKey)
    if (!keys) return
    for (const key of keys) this.requestPoll(key)
  }

  private unindexWakeKey(wakeKey: string | null, topicKey: string) {
    if (!wakeKey) return
    const bucket = this.wakeIndex.get(wakeKey)
    if (!bucket) return
    bucket.delete(topicKey)
    if (bucket.size === 0) this.wakeIndex.delete(wakeKey)
  }

  close() {
    this.closed = true
    for (const topic of this.topics.values()) {
      clearInterval(topic.timer)
      topic.subscribers.clear()
    }
    this.topics.clear()
    this.wakeIndex.clear()
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
