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
  loadEvents: (afterSequence: number) => Promise<SequencedSseEvent[]>
  lastSequence: number
  polling: boolean
  pollRequested: boolean
  timer: ReturnType<typeof setInterval>
}

type ActiveSseStream = {
  res: ServerResponse
  socket: Socket | null
  close: () => void
}

export class CloudSseStreamRegistry {
  private readonly streams = new Set<ActiveSseStream>()
  private closing = false

  track(req: IncomingMessage, res: ServerResponse, cleanup: () => void) {
    if (this.closing) {
      const socket = res.socket || req.socket || null
      cleanup()
      if (!res.writableEnded && !res.destroyed) res.end()
      if (!res.destroyed) res.destroy()
      if (socket && !socket.destroyed) socket.destroy()
      return false
    }

    let closed = false
    const stream: ActiveSseStream = {
      res,
      socket: res.socket || req.socket || null,
      close: () => {
        if (closed) return
        closed = true
        this.streams.delete(stream)
        req.off('close', stream.close)
        res.off('close', stream.close)
        res.off('finish', stream.close)
        cleanup()
      },
    }
    this.streams.add(stream)
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
      loadEvents: (afterSequence: number) => Promise<SequencedSseEvent[]>
      listener: (event: SequencedSseEvent) => void
      onError?: (error: unknown) => void
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
