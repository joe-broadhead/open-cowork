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
        timer: setInterval(() => {
          void this.poll(input.key)
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

  private async poll(key: string) {
    if (this.closed) return
    const topic = this.topics.get(key)
    if (!topic || topic.polling) return
    topic.polling = true
    try {
      const events = await topic.loadEvents(topic.lastSequence)
      if (this.closed || this.topics.get(key) !== topic) return
      for (const event of events) {
        if (event.sequence <= topic.lastSequence) continue
        topic.lastSequence = event.sequence
        for (const subscriber of topic.subscribers) {
          if (event.sequence <= subscriber.lastSequence) continue
          subscriber.listener(event)
          subscriber.lastSequence = event.sequence
        }
      }
    } catch (error) {
      for (const subscriber of topic.subscribers) subscriber.onError?.(error)
    } finally {
      if (this.topics.get(key) === topic) topic.polling = false
    }
  }
}
