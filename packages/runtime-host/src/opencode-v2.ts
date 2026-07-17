import type {
  LocationRef,
  ModelRef,
  OpencodeClient,
  PermissionV2Request,
  PromptInputFileAttachment,
  QuestionV2Request,
  SessionInputAdmitted,
  SessionMessage,
  SessionV2Info,
} from '@opencode-ai/sdk/v2'

export type NativePromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; url?: string; uri?: string; filename?: string; name?: string; mime?: string }

export type NativePromptModel = {
  providerID: string
  id?: string
  modelID?: string
  variant?: string
}

export type NativeSessionCreateInput = {
  location: LocationRef
  id?: string
  agent?: string
  model?: ModelRef
}

/**
 * Peel the OpenCode SDK V2 **double data envelope** `{ data: { data: T } }`.
 *
 * Footgun (JOE-873): the generated client already wraps HTTP JSON once; some
 * routes nest a second `{ data }` so product code must use this helper rather
 * than reading `.data` ad hoc. When bumping `@opencode-ai/sdk`, re-check whether
 * envelopes collapsed to a single layer — if so, keep this function as the sole
 * unwrap point and update tests in `tests/opencode-v2-unwrap.test.ts`.
 *
 * SDK bump checklist:
 * 1. Inspect a `session.create` / `session.get` raw response shape.
 * 2. Run unwrap unit tests (single vs double envelope).
 * 3. Only then change this function — never scatter `.data.data` in call sites.
 */
export function unwrapNativeData<T>(value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode V2 returned an invalid response envelope.')
  }
  const outer = value as { data?: unknown }
  if (!outer.data || typeof outer.data !== 'object' || Array.isArray(outer.data)) {
    throw new Error('OpenCode V2 returned an invalid data payload.')
  }
  const inner = outer.data as { data?: unknown }
  if (inner.data === undefined) {
    throw new Error('OpenCode V2 response did not contain data.')
  }
  return inner.data as T
}

export async function createNativeSession(
  client: OpencodeClient,
  input: NativeSessionCreateInput,
) {
  const directory = input.location.directory.trim()
  if (!directory) {
    throw new Error('OpenCode V2 session creation requires an explicit location directory.')
  }
  // OpenCode v2 validates POST /api/session as an object body. The
  // generated SDK omits the body when every optional field is absent, so send
  // the already-selected runtime location as the smallest semantically neutral
  // native field. OpenCode still owns session ids, agent choice, and execution.
  const response = await client.v2.session.create({
    ...input,
    location: {
      ...input.location,
      directory,
    },
  }, { throwOnError: true })
  return unwrapNativeData<SessionV2Info>(response)
}

export async function getNativeSession(client: OpencodeClient, sessionID: string) {
  const response = await client.v2.session.get({ sessionID }, { throwOnError: true })
  return unwrapNativeData<SessionV2Info>(response)
}

export async function listNativeSessions(
  client: OpencodeClient,
  options: { directory?: string; project?: string; subpath?: string; search?: string } = {},
) {
  const sessions: SessionV2Info[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  do {
    const response = await client.v2.session.list({
      ...options,
      limit: 200,
      ...(cursor ? { cursor } : { order: 'asc' }),
    }, { throwOnError: true })
    sessions.push(...response.data.data)
    const next = response.data.cursor.next
    if (!next || seenCursors.has(next)) break
    seenCursors.add(next)
    cursor = next
  } while (cursor)
  return sessions
}

export async function listNativeSessionMessages(
  client: OpencodeClient,
  sessionID: string,
  options: { limit?: number; order?: 'asc' | 'desc' } = {},
) {
  const messages: SessionMessage[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  do {
    const response = await client.v2.session.messages({
      sessionID,
      limit: options.limit || 200,
      ...(cursor ? { cursor } : { order: options.order || 'asc' }),
    }, { throwOnError: true })
    messages.push(...response.data.data)
    const next = response.data.cursor.next
    if (!next || seenCursors.has(next)) break
    seenCursors.add(next)
    cursor = next
  } while (cursor)
  return messages
}

export async function listNativeActiveSessionIds(client: OpencodeClient) {
  const response = await client.v2.session.active({ throwOnError: true })
  return new Set(Object.keys(response.data.data))
}

/**
 * Store a provider API key through OpenCode's native V2 integration contract.
 *
 * V2 providers point at the integration that owns their credentials. The key
 * connection endpoint replaces the integration's existing credential, so this
 * is safe to run on every managed-runtime start without accumulating secrets.
 */
export async function connectNativeProviderApiKey(
  client: OpencodeClient,
  providerID: string,
  key: string,
) {
  const providerResponse = await client.v2.provider.get(
    { providerID },
    { throwOnError: true },
  )
  const provider = providerResponse.data.data
  const integrationID = provider.integrationID
  if (!integrationID) {
    throw new Error(`OpenCode V2 provider ${providerID} does not expose a credential integration.`)
  }

  const integrationResponse = await client.v2.integration.get(
    { integrationID },
    { throwOnError: true },
  )
  const supportsKey = integrationResponse.data.data.methods.some((method) => method.type === 'key')
  if (!supportsKey) {
    throw new Error(`OpenCode V2 integration ${integrationID} does not support API-key credentials.`)
  }

  await client.v2.integration.connect.key({
    integrationID,
    key,
    label: 'Open Cowork',
  }, { throwOnError: true })
}

function nativeModelRef(model: NativePromptModel): ModelRef {
  const id = model.id || model.modelID
  if (!id) throw new Error('OpenCode V2 prompt model is missing its model id.')
  return {
    providerID: model.providerID,
    id,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

function promptFiles(parts: NativePromptPart[]): PromptInputFileAttachment[] {
  return parts.flatMap((part) => {
    if (part.type !== 'file') return []
    const uri = part.uri || part.url
    if (!uri) return []
    const name = part.name || part.filename
    return [{ uri, ...(name ? { name } : {}) }]
  })
}

function promptText(parts: NativePromptPart[]) {
  return parts
    .filter((part): part is Extract<NativePromptPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

export async function promptNativeSession(client: OpencodeClient, input: {
  sessionID: string
  parts: NativePromptPart[]
  agent?: string | null
  model?: NativePromptModel | null
  messageID?: string | null
  signal?: AbortSignal
}) {
  const model = input.model ? nativeModelRef(input.model) : null
  if (input.agent || model) {
    const session = await getNativeSession(client, input.sessionID)
    if (input.agent && session.agent !== input.agent) {
      await client.v2.session.switchAgent({
        sessionID: input.sessionID,
        agent: input.agent,
      }, { throwOnError: true, signal: input.signal })
    }
    if (
      model
      && (
        session.model?.providerID !== model.providerID
        || session.model.id !== model.id
        || (session.model.variant || 'default') !== (model.variant || 'default')
      )
    ) {
      await client.v2.session.switchModel({
        sessionID: input.sessionID,
        model,
      }, { throwOnError: true, signal: input.signal })
    }
  }

  const files = promptFiles(input.parts)
  const response = await client.v2.session.prompt({
    sessionID: input.sessionID,
    ...(input.messageID ? { id: input.messageID } : {}),
    prompt: {
      text: promptText(input.parts),
      ...(files.length > 0 ? { files } : {}),
    },
    delivery: 'queue',
    resume: true,
  }, { throwOnError: true, signal: input.signal })
  return unwrapNativeData<SessionInputAdmitted>(response)
}

export async function interruptNativeSession(
  client: OpencodeClient,
  sessionID: string,
  signal?: AbortSignal,
) {
  await client.v2.session.interrupt({ sessionID }, { throwOnError: true, signal })
}

export async function listNativePendingQuestions(client: OpencodeClient) {
  const response = await client.v2.question.request.list(undefined, { throwOnError: true })
  return response.data.data
}

export async function listNativePendingPermissions(client: OpencodeClient) {
  const response = await client.v2.permission.request.list(undefined, { throwOnError: true })
  return response.data.data
}

export function findNativeQuestionSession(requests: QuestionV2Request[], requestID: string) {
  return requests.find((request) => request.id === requestID)?.sessionID || null
}

export function findNativePermissionSession(requests: PermissionV2Request[], requestID: string) {
  return requests.find((request) => request.id === requestID)?.sessionID || null
}
