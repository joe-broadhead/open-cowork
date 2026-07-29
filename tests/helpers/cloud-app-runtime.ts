import type {
  CloudRuntimeAdapter,
  CloudRuntimeEvent,
  CloudRuntimeEventListener,
  CloudRuntimePromptPart,
} from '@open-cowork/cloud-server/runtime-adapter'

export class FakeRuntime implements CloudRuntimeAdapter {
  prompts: Array<{ sessionId: string, parts: CloudRuntimePromptPart[], agent: string }> = []
  questionReplies: Array<{ requestId: string, answers: unknown[] }> = []
  questionRejects: Array<{ requestId: string }> = []
  permissionResponses: Array<{ permissionId: string, allowed: boolean }> = []
  listeners: CloudRuntimeEventListener[] = []
  closed = false
  private nextSession = 0

  async createSession() {
    this.nextSession += 1
    return {
      id: `session-${this.nextSession}`,
      title: `Session ${this.nextSession}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async promptSession(input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    this.prompts.push({ sessionId: input.sessionId, parts: input.parts, agent: input.agent })
    return {
      events: [{
        type: 'assistant.message',
        payload: {
          sessionId: input.sessionId,
          messageId: `${input.sessionId}:assistant`,
          content: 'runtime answer',
        },
      }, {
        type: 'session.idle',
        payload: {
          sessionId: input.sessionId,
        },
      }],
    }
  }

  async abortSession() {}

  async replyToQuestion(input: { requestId: string, answers: unknown[] }) {
    this.questionReplies.push({ requestId: input.requestId, answers: input.answers })
  }

  async rejectQuestion(input: { requestId: string }) {
    this.questionRejects.push({ requestId: input.requestId })
  }

  async respondToPermission(input: { permissionId: string, allowed: boolean }) {
    this.permissionResponses.push({ permissionId: input.permissionId, allowed: input.allowed })
  }

  subscribeEvents(listener: CloudRuntimeEventListener) {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener)
    }
  }

  async emitAssistant(sessionId: string, content: string) {
    await this.emit({
      type: 'assistant.message',
      payload: {
        sessionId,
        messageId: `${sessionId}:external`,
        content,
      },
    })
  }

  async emit(event: CloudRuntimeEvent) {
    for (const listener of this.listeners) {
      await listener(event)
    }
  }

  close() {
    this.closed = true
  }
}

export class AdmittedPromptRuntime extends FakeRuntime {
  async promptSession(input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    this.prompts.push({ sessionId: input.sessionId, parts: input.parts, agent: input.agent })
    return { events: [] }
  }

  emitIdle(sessionId: string) {
    return this.emit({ type: 'session.idle', payload: { sessionId } })
  }

  emitRuntimeError(sessionId: string, message: string) {
    return this.emit({ type: 'runtime.error', payload: { sessionId, message } })
  }
}

export class SlowPromptRuntime extends FakeRuntime {
  private startedResolve!: () => void
  private releaseResolve!: () => void
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })
  private readonly released = new Promise<void>((resolve) => {
    this.releaseResolve = resolve
  })

  async promptSession(input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    this.startedResolve()
    await this.released
    return super.promptSession(input)
  }

  release() {
    this.releaseResolve()
  }
}

export class ShutdownAwareSlowPromptRuntime extends FakeRuntime {
  private startedResolve!: () => void
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })
  abortCalls = 0
  observedAbort = false

  async promptSession(input: {
    sessionId: string
    parts: CloudRuntimePromptPart[]
    agent: string
    signal?: AbortSignal
  }) {
    this.startedResolve()
    await new Promise<void>((_resolve, reject) => {
      if (!input.signal) {
        reject(new Error('Expected shutdown signal.'))
        return
      }
      if (input.signal.aborted) {
        this.observedAbort = true
        reject(input.signal.reason)
        return
      }
      input.signal.addEventListener('abort', () => {
        this.observedAbort = true
        reject(input.signal?.reason instanceof Error ? input.signal.reason : new Error('Worker command aborted.'))
      }, { once: true })
    })
    return super.promptSession(input)
  }

  async abortSession() {
    this.abortCalls += 1
  }
}
