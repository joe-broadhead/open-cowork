import type { AssistantMessage, Message, OpencodeClient, Part, Session } from '@opencode-ai/sdk'

// A shared, TYPED fake OpencodeClient for scheduler/daemon tests.
//
// The gateway only touches `client.session.{create,get,list,messages,prompt,
// abort, delete}`. We derive that surface FROM the real SDK type, so an SDK upgrade
// that renames or reshapes any of those methods breaks compilation here (and in
// every test that imports this helper) instead of silently passing an `any`.
//
// `UsedSessionApi` is the drift tripwire: Pick against the real class instance
// type fails to compile the moment a method name disappears upstream. The
// response builders below are typed against the real `Session` / `Message` /
// `Part` shapes, so a changed response contract fails here too.

export type UsedSessionApi = Pick<OpencodeClient['session'], 'create' | 'get' | 'list' | 'messages' | 'prompt' | 'promptAsync' | 'abort' | 'delete'>

// Fields-style RequestResult envelope (ThrowOnError=false): every SDK session
// method resolves to `{ data, error, request, response }`. Exported so hand-typed
// fakes (e.g. scheduler.test.ts's `client()`) can build the same drift-checked
// envelope without weakening their return types to `any`.
export function fields<T>(data: T): { data: T; error: undefined; request: Request; response: Response } {
  return { data, error: undefined, request: new Request('http://localhost/'), response: new Response(null, { status: 200 }) }
}

export function buildFakeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    projectID: 'prj_fake',
    directory: '/tmp/fake',
    title: 'GW: fake session',
    version: '0.0.0-fake',
    time: { created: 0, updated: 0 },
    ...overrides,
  }
}

export function buildAssistantMessage(overrides: Partial<AssistantMessage> & { id: string; sessionID: string }): AssistantMessage {
  return {
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'msg_root',
    modelID: 'fake-model',
    providerID: 'fake-provider',
    mode: 'build',
    path: { cwd: '/tmp/fake', root: '/tmp/fake' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  }
}

export interface FakeOpencodeClientBehavior {
  /** Called on session.create; return a partial Session to seed the store. */
  onCreate?: (body: { parentID?: string; title?: string } | undefined, directory: string | undefined) => Partial<Session>
  /** Messages returned by session.messages for a given session id. */
  messagesFor?: (sessionId: string) => Array<{ info: Message; parts: Part[] }>
  /** Override session.get for a given id. */
  getSession?: (sessionId: string) => Partial<Session> | undefined
  /** Throw from session.prompt to simulate provider failure. */
  promptError?: Error
  beforeCreate?: () => void | Promise<void>
  beforePrompt?: (sessionId: string | undefined) => void | Promise<void>
  onAbort?: (sessionId: string) => void
}

export interface FakeOpencodeClientHandle {
  client: OpencodeClient
  sessions: Session[]
  creates: Array<{ parentID?: string; title?: string } | undefined>
  prompts: string[]
  promptAsyncs: string[]
  aborts: string[]
  deletes: string[]
}

/**
 * Build a typed fake OpencodeClient plus a handle exposing recorded activity.
 *
 * The returned `client` is the real `OpencodeClient` type. The single
 * `as unknown as OpencodeClient` cast is unavoidable and intentional:
 * OpencodeClient is a class with a protected `_client` member, so no object
 * literal is nominally assignable to it. The cast is contained to this one
 * boundary; the `session` object above is fully checked against `UsedSessionApi`
 * first, which is where drift is actually caught.
 */
export function createFakeOpencodeClient(behavior: FakeOpencodeClientBehavior = {}): FakeOpencodeClientHandle {
  const sessions: Session[] = []
  const creates: Array<{ parentID?: string; title?: string } | undefined> = []
  const prompts: string[] = []
  const promptAsyncs: string[] = []
  const aborts: string[] = []
  const deletes: string[] = []
  let counter = 0

  const session: UsedSessionApi = {
    create: async options => {
      await behavior.beforeCreate?.()
      const body = options?.body
      const directory = options?.query?.directory
      creates.push(body)
      const seeded = behavior.onCreate?.(body, directory) ?? {}
      const created = buildFakeSession({ id: `ses_${++counter}`, title: body?.title, directory, ...seeded })
      sessions.push(created)
      return fields(created)
    },
    get: async options => {
      const id = options.path.id
      const override = behavior.getSession?.(id)
      const found = sessions.find(s => s.id === id)
      if (override !== undefined) return fields(buildFakeSession({ id, ...found, ...override }))
      if (!found) throw Object.assign(new Error('session not found'), { status: 404 })
      return fields(found)
    },
    list: async options => {
      const directory = options?.query?.directory
      return fields(sessions.filter(s => !directory || s.directory === directory))
    },
    messages: async options => {
      const id = options.path.id
      return fields(behavior.messagesFor?.(id) ?? [])
    },
    prompt: async options => {
      const id = options.path.id
      prompts.push(id)
      await behavior.beforePrompt?.(id)
      if (behavior.promptError) throw behavior.promptError
      return fields({ info: buildAssistantMessage({ id: `msg_${++counter}`, sessionID: id }), parts: [] as Part[] })
    },
    // Models the real SDK 1.17.16 fire-and-forget: resolves an empty 204-like
    // response at enqueue and NEVER surfaces a mid-turn provider error. Present
    // so that any caller which fails to pass `async:false` routes here and its
    // turn-failure detection visibly breaks in tests (guards the blocking-dispatch
    // contract of the scheduler/supervisor/reply paths).
    promptAsync: async options => {
      promptAsyncs.push(options.path.id)
      return fields(undefined) as any
    },
    abort: async options => {
      const id = options.path.id
      aborts.push(id)
      behavior.onAbort?.(id)
      return fields(true)
    },
    delete: async options => {
      const id = options.path.id
      deletes.push(id)
      const index = sessions.findIndex(session => session.id === id)
      if (index >= 0) sessions.splice(index, 1)
      return fields(true)
    },
  }

  return { client: { session } as unknown as OpencodeClient, sessions, creates, prompts, promptAsyncs, aborts, deletes }
}
