export const CLOUD_SESSION_PROJECTION_CONTRACT_VERSION = 1
export const CLOUD_PROJECTION_SYNC_CONTRACT_VERSION = 1
export const CLOUD_AUTOMATION_EVENT_STREAM_VERSION = 1
export const CLOUD_SESSION_SSE_MAX_BUFFERED_BYTES = 8 * 1024 * 1024
// Leave room for the event envelope and another queued event within the
// connection-level SSE cap. The projection applies this as an aggregate budget
// across all inline tool attachments in one tool call.
export const CLOUD_TOOL_ATTACHMENT_MAX_DATA_URL_BYTES = CLOUD_SESSION_SSE_MAX_BUFFERED_BYTES / 2
export const CLOUD_TOOL_ATTACHMENT_MAX_FILENAME_BYTES = 128

export type CloudSessionProjectionFacet =
  | 'messages'
  | 'toolCalls'
  | 'taskRuns'
  | 'approvals'
  | 'questions'
  | 'artifacts'
  | 'todos'
  | 'cost'
  | 'status'
  | 'errors'
  | 'origin'
  | 'projectSource'
  | 'workspace'
  | 'control'

export type CloudSessionProjectionProducer =
  | 'cloud-runtime'
  | 'cloud-service'
  | 'cloud-gateway'

export type CloudSessionProjectionConsumer =
  | 'desktop'
  | 'cloud-web'
  | 'gateway'
  | 'worker'

export type CloudSessionEventContractEntry = {
  type: string
  projected: boolean
  facets: readonly CloudSessionProjectionFacet[]
  producers: readonly CloudSessionProjectionProducer[]
  consumers: readonly CloudSessionProjectionConsumer[]
  channelRenderable: boolean
  description: string
}

export const CLOUD_SESSION_EVENT_CONTRACT = [
  {
    type: 'session.created',
    projected: true,
    facets: ['status', 'workspace'],
    producers: ['cloud-service'],
    consumers: ['desktop', 'cloud-web'],
    channelRenderable: false,
    description: 'Cloud session metadata was created and is ready to project.',
  },
  {
    type: 'session.imported',
    projected: true,
    facets: ['origin', 'status', 'workspace'],
    producers: ['cloud-service'],
    consumers: ['desktop', 'cloud-web'],
    channelRenderable: false,
    description: 'A redacted local session import completed into a cloud workspace.',
  },
  {
    type: 'session.project_source.bound',
    projected: true,
    facets: ['projectSource', 'workspace'],
    producers: ['cloud-service'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: false,
    description: 'A cloud-safe project source or snapshot was attached to a session.',
  },
  {
    type: 'prompt.submitted',
    projected: true,
    facets: ['messages', 'status'],
    producers: ['cloud-service', 'cloud-gateway'],
    consumers: ['desktop', 'cloud-web', 'gateway', 'worker'],
    channelRenderable: false,
    description: 'A user or channel prompt was accepted by the cloud control plane.',
  },
  {
    type: 'assistant.message',
    projected: true,
    facets: ['messages'],
    producers: ['cloud-runtime'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: true,
    description: 'Assistant text emitted by the OpenCode runtime after cloud normalization.',
  },
  {
    type: 'tool.call',
    projected: true,
    facets: ['toolCalls', 'taskRuns', 'status'],
    producers: ['cloud-runtime'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: true,
    description: 'Normalized tool-call progress or completion from the OpenCode runtime.',
  },
  {
    type: 'task.run',
    projected: true,
    facets: ['taskRuns'],
    producers: ['cloud-runtime', 'cloud-service'],
    consumers: ['desktop', 'cloud-web'],
    channelRenderable: false,
    description: 'Projected child-task or delegated run state.',
  },
  {
    type: 'permission.requested',
    projected: true,
    facets: ['approvals', 'status'],
    producers: ['cloud-runtime'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: true,
    description: 'A runtime permission request that requires a human decision.',
  },
  {
    type: 'permission.resolved',
    projected: true,
    facets: ['approvals'],
    producers: ['cloud-runtime', 'cloud-service', 'cloud-gateway'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: false,
    description: 'A runtime permission request was allowed or denied.',
  },
  {
    type: 'question.asked',
    projected: true,
    facets: ['questions', 'status'],
    producers: ['cloud-runtime'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: true,
    description: 'A runtime question that requires a human answer.',
  },
  {
    type: 'question.resolved',
    projected: true,
    facets: ['questions'],
    producers: ['cloud-runtime', 'cloud-service', 'cloud-gateway'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: false,
    description: 'A runtime question was answered or rejected.',
  },
  {
    type: 'todos.updated',
    projected: true,
    facets: ['todos'],
    producers: ['cloud-runtime'],
    consumers: ['desktop', 'cloud-web'],
    channelRenderable: false,
    description: 'Runtime todo state was replaced with the latest canonical list.',
  },
  {
    type: 'cost.updated',
    projected: true,
    facets: ['cost'],
    producers: ['cloud-runtime'],
    consumers: ['desktop', 'cloud-web'],
    channelRenderable: false,
    description: 'Cost and token usage changed for the cloud session.',
  },
  {
    type: 'artifact.created',
    projected: true,
    facets: ['artifacts'],
    producers: ['cloud-runtime', 'cloud-service'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: true,
    description: 'A cloud artifact became available through object storage.',
  },
  {
    type: 'artifact.updated',
    projected: true,
    facets: ['artifacts'],
    producers: ['cloud-service'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: true,
    description: 'Cloud artifact deliverable status or provenance changed.',
  },
  {
    type: 'session.status',
    projected: true,
    facets: ['status'],
    producers: ['cloud-runtime', 'cloud-service'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: false,
    description: 'Runtime session status changed without closing the session.',
  },
  {
    type: 'session.idle',
    projected: true,
    facets: ['status'],
    producers: ['cloud-runtime', 'cloud-service'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: false,
    description: 'Runtime execution settled and the session is idle.',
  },
  {
    type: 'session.aborted',
    projected: true,
    facets: ['status'],
    producers: ['cloud-service', 'cloud-runtime'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: false,
    description: 'Cloud execution was aborted for the session.',
  },
  {
    type: 'runtime.error',
    projected: true,
    facets: ['errors', 'status'],
    producers: ['cloud-runtime', 'cloud-service'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: false,
    description: 'Runtime or worker execution failed after cloud redaction.',
  },
  {
    type: 'snapshot.required',
    projected: false,
    facets: ['control'],
    producers: ['cloud-service'],
    consumers: ['desktop', 'cloud-web', 'gateway'],
    channelRenderable: false,
    description: 'A client must hydrate a fresh snapshot before resuming events.',
  },
  {
    type: 'channel.delivery',
    projected: false,
    facets: ['control'],
    producers: ['cloud-gateway', 'cloud-service'],
    consumers: ['gateway', 'cloud-web'],
    channelRenderable: false,
    description: 'A channel delivery changed state; not part of session projection.',
  },
] as const satisfies readonly CloudSessionEventContractEntry[]

type CloudSessionEventContract = typeof CLOUD_SESSION_EVENT_CONTRACT[number]
type CloudProjectedSessionEventContract = Extract<CloudSessionEventContract, { projected: true }>

export type CloudProjectedSessionEventType = CloudProjectedSessionEventContract['type']
export type CloudSessionEventType = CloudSessionEventContract['type']

export type CloudSessionEventRecord<Type extends string = CloudSessionEventType> = {
  eventId?: string
  tenantId?: string
  sessionId?: string
  sequence: number
  type: Type
  payload: Record<string, unknown>
  createdAt: string
  entityType?: string
  entityId?: string
  operation?: string
  projectionVersion?: number
}

export type CloudSessionProjectionEventRecord<Type extends string = CloudProjectedSessionEventType> =
  CloudSessionEventRecord<Type>

export type CloudProjectionFenceScope = 'session' | 'workspace' | 'workflow-run' | 'client'
export type CloudProjectionSyncErrorKind = 'runtime' | 'projection' | 'transport' | 'lease' | 'policy' | 'unknown'

export type CloudProjectionFenceToken = {
  version: typeof CLOUD_PROJECTION_SYNC_CONTRACT_VERSION
  scope: CloudProjectionFenceScope
  tenantId: string
  workspaceId?: string
  sessionId?: string
  workflowId?: string
  runId?: string
  clientId?: string
  commandId?: string
  sequence?: number
  projectionVersion?: number
  checkpointVersion?: number
  issuedAt: string
  expiresAt?: string
}

export type CloudProjectionCheckpoint = {
  version: typeof CLOUD_PROJECTION_SYNC_CONTRACT_VERSION
  scope: CloudProjectionFenceScope
  tenantId: string
  workspaceId?: string
  sessionId?: string
  workflowId?: string
  runId?: string
  clientId?: string
  sequence: number
  projectionVersion: number
  checkpointVersion?: number
  updatedAt: string
}

export type CloudProjectionSyncError = {
  kind: CloudProjectionSyncErrorKind
  code: string
  message: string
  retryable: boolean
}

export type CloudProjectionFenceWaitErrorCode =
  | 'projection_fence_checkpoint_missing'
  | 'projection_fence_identity_mismatch'
  | 'projection_fence_expired'
  | 'projection_fence_stale'
  | 'projection_fence_timeout'

export type CloudProjectionFenceWaitResult =
  | {
    ok: true
    code: 'projection_fence_observed'
    fence: CloudProjectionFenceToken
    checkpoint: CloudProjectionCheckpoint
    waitedMs: number
  }
  | {
    ok: false
    code: CloudProjectionFenceWaitErrorCode
    fence: CloudProjectionFenceToken
    checkpoint: CloudProjectionCheckpoint | null
    error: CloudProjectionSyncError
    waitedMs: number
  }

export type CloudProjectionFenceWaitInput = {
  fence: CloudProjectionFenceToken
  readCheckpoint: () => Promise<CloudProjectionCheckpoint | null>
  timeoutMs: number
  intervalMs?: number
  nowMs?: () => number
  sleep?: (durationMs: number) => Promise<void>
}

export type CloudAutomationEventSource =
  | 'desktop'
  | 'cloud-web'
  | 'cloud-worker'
  | 'cloud-gateway'
  | 'standalone-gateway'
  | 'paired-desktop'
  | 'workflow'

export type CloudAutomationEventEnvelope<Payload extends Record<string, unknown> = Record<string, unknown>> = {
  version: typeof CLOUD_AUTOMATION_EVENT_STREAM_VERSION
  eventId: string
  type: string
  source: CloudAutomationEventSource
  scope: CloudProjectionFenceScope
  tenantId: string
  workspaceId?: string
  sessionId?: string
  workflowId?: string
  runId?: string
  clientId?: string
  sequence: number
  projectionVersion?: number
  fence?: CloudProjectionFenceToken
  error?: CloudProjectionSyncError
  payload: Payload
  createdAt: string
}

export type CloudAutomationTerminalStatusRecord<Payload extends Record<string, unknown> = Record<string, unknown>> = {
  kind: 'open-cowork.automation.event'
  version: typeof CLOUD_AUTOMATION_EVENT_STREAM_VERSION
  event: CloudAutomationEventEnvelope<Payload>
  emittedAt: string
  redacted: true
}

type CloudProjectionIdentityInput = {
  scope: CloudProjectionFenceScope
  tenantId: string
  workspaceId?: string
  sessionId?: string
  workflowId?: string
  runId?: string
  clientId?: string
}

const EXACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

function assertExactCloudIdentity(value: string | undefined, label: string): string {
  if (!value || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (!EXACT_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be an exact canonical identifier.`)
  }
  return normalized
}

function assertNonNegativeInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`)
  return value
}

function assertRequiredNonNegativeInteger(value: number | undefined, label: string): number {
  const normalized = assertNonNegativeInteger(value, label)
  if (normalized === undefined) throw new Error(`${label} is required.`)
  return normalized
}

function assertProjectionIdentity(input: CloudProjectionIdentityInput): Required<Pick<CloudProjectionIdentityInput, 'scope' | 'tenantId'>> & CloudProjectionIdentityInput {
  const identity = {
    ...input,
    tenantId: assertExactCloudIdentity(input.tenantId, 'tenantId'),
  }
  switch (input.scope) {
    case 'session':
      return {
        ...identity,
        sessionId: assertExactCloudIdentity(input.sessionId, 'sessionId'),
      }
    case 'workspace':
      return {
        ...identity,
        workspaceId: assertExactCloudIdentity(input.workspaceId, 'workspaceId'),
      }
    case 'workflow-run':
      return {
        ...identity,
        workflowId: assertExactCloudIdentity(input.workflowId, 'workflowId'),
        runId: assertExactCloudIdentity(input.runId, 'runId'),
      }
    case 'client':
      return {
        ...identity,
        clientId: assertExactCloudIdentity(input.clientId, 'clientId'),
      }
  }
}

export function cloudProjectionFenceIdentityKey(input: CloudProjectionIdentityInput): string {
  const identity = assertProjectionIdentity(input)
  switch (identity.scope) {
    case 'session':
      return `session:${identity.tenantId}:${identity.sessionId}`
    case 'workspace':
      return `workspace:${identity.tenantId}:${identity.workspaceId}`
    case 'workflow-run':
      return `workflow-run:${identity.tenantId}:${identity.workflowId}:${identity.runId}`
    case 'client':
      return `client:${identity.tenantId}:${identity.clientId}`
  }
}

export function createCloudProjectionFenceToken(input: Omit<CloudProjectionFenceToken, 'version' | 'issuedAt'> & { issuedAt?: string }): CloudProjectionFenceToken {
  const identity = assertProjectionIdentity(input)
  const sequence = assertNonNegativeInteger(input.sequence, 'sequence')
  const projectionVersion = assertNonNegativeInteger(input.projectionVersion, 'projectionVersion')
  const checkpointVersion = assertNonNegativeInteger(input.checkpointVersion, 'checkpointVersion')
  if (sequence === undefined && projectionVersion === undefined && checkpointVersion === undefined) {
    throw new Error('A projection fence requires sequence, projectionVersion, or checkpointVersion.')
  }
  return {
    version: CLOUD_PROJECTION_SYNC_CONTRACT_VERSION,
    scope: identity.scope,
    tenantId: identity.tenantId,
    ...(identity.workspaceId ? { workspaceId: identity.workspaceId } : {}),
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(identity.workflowId ? { workflowId: identity.workflowId } : {}),
    ...(identity.runId ? { runId: identity.runId } : {}),
    ...(identity.clientId ? { clientId: identity.clientId } : {}),
    ...(input.commandId ? { commandId: assertExactCloudIdentity(input.commandId, 'commandId') } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(projectionVersion !== undefined ? { projectionVersion } : {}),
    ...(checkpointVersion !== undefined ? { checkpointVersion } : {}),
    issuedAt: input.issuedAt || new Date().toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  }
}

export function createCloudProjectionCheckpoint(input: Omit<CloudProjectionCheckpoint, 'version'>): CloudProjectionCheckpoint {
  const identity = assertProjectionIdentity(input)
  return {
    version: CLOUD_PROJECTION_SYNC_CONTRACT_VERSION,
    scope: identity.scope,
    tenantId: identity.tenantId,
    ...(identity.workspaceId ? { workspaceId: identity.workspaceId } : {}),
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(identity.workflowId ? { workflowId: identity.workflowId } : {}),
    ...(identity.runId ? { runId: identity.runId } : {}),
    ...(identity.clientId ? { clientId: identity.clientId } : {}),
    sequence: assertRequiredNonNegativeInteger(input.sequence, 'sequence'),
    projectionVersion: assertRequiredNonNegativeInteger(input.projectionVersion, 'projectionVersion'),
    ...(input.checkpointVersion !== undefined ? { checkpointVersion: assertNonNegativeInteger(input.checkpointVersion, 'checkpointVersion') || 0 } : {}),
    updatedAt: input.updatedAt,
  }
}

export function cloudProjectionFenceObserved(
  fence: CloudProjectionFenceToken,
  checkpoint: CloudProjectionCheckpoint,
): boolean {
  if (cloudProjectionFenceIdentityKey(fence) !== cloudProjectionFenceIdentityKey(checkpoint)) return false
  if (fence.sequence !== undefined && checkpoint.sequence < fence.sequence) return false
  if (fence.projectionVersion !== undefined && checkpoint.projectionVersion < fence.projectionVersion) return false
  if (fence.checkpointVersion !== undefined && (checkpoint.checkpointVersion ?? -1) < fence.checkpointVersion) return false
  return true
}

function projectionSyncError(
  code: CloudProjectionFenceWaitErrorCode,
  message: string,
  retryable: boolean,
): CloudProjectionSyncError {
  return {
    kind: 'projection',
    code,
    message,
    retryable,
  }
}

function fenceExpired(fence: CloudProjectionFenceToken, nowMs: number) {
  if (!fence.expiresAt) return false
  const expiresAt = Date.parse(fence.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt <= nowMs
}

export function evaluateCloudProjectionFenceCheckpoint(input: {
  fence: CloudProjectionFenceToken
  checkpoint: CloudProjectionCheckpoint | null
  nowMs?: number
  waitedMs?: number
}): CloudProjectionFenceWaitResult {
  const waitedMs = input.waitedMs || 0
  if (fenceExpired(input.fence, input.nowMs ?? Date.now())) {
    return {
      ok: false,
      code: 'projection_fence_expired',
      fence: input.fence,
      checkpoint: input.checkpoint,
      error: projectionSyncError('projection_fence_expired', 'Projection fence expired before the checkpoint was observed.', false),
      waitedMs,
    }
  }
  if (!input.checkpoint) {
    return {
      ok: false,
      code: 'projection_fence_checkpoint_missing',
      fence: input.fence,
      checkpoint: null,
      error: projectionSyncError('projection_fence_checkpoint_missing', 'No projection checkpoint is available for this fence identity.', true),
      waitedMs,
    }
  }

  if (cloudProjectionFenceIdentityKey(input.fence) !== cloudProjectionFenceIdentityKey(input.checkpoint)) {
    return {
      ok: false,
      code: 'projection_fence_identity_mismatch',
      fence: input.fence,
      checkpoint: input.checkpoint,
      error: projectionSyncError('projection_fence_identity_mismatch', 'Projection checkpoint identity does not match the fence identity.', false),
      waitedMs,
    }
  }

  if (cloudProjectionFenceObserved(input.fence, input.checkpoint)) {
    return {
      ok: true,
      code: 'projection_fence_observed',
      fence: input.fence,
      checkpoint: input.checkpoint,
      waitedMs,
    }
  }

  return {
    ok: false,
    code: 'projection_fence_stale',
    fence: input.fence,
    checkpoint: input.checkpoint,
    error: projectionSyncError('projection_fence_stale', 'Projection checkpoint is behind the fence target.', true),
    waitedMs,
  }
}

function defaultFenceWaitSleep(durationMs: number) {
  return new Promise<void>((resolve) => {
    const timer = (globalThis as { setTimeout?: (callback: () => void, timeoutMs: number) => unknown }).setTimeout
    if (!timer) {
      resolve()
      return
    }
    timer(resolve, durationMs)
  })
}

export async function waitForCloudProjectionFence(
  input: CloudProjectionFenceWaitInput,
): Promise<CloudProjectionFenceWaitResult> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0) {
    throw new Error('Projection fence wait timeoutMs must be a non-negative number.')
  }
  const intervalMs = Math.max(1, input.intervalMs ?? 100)
  const nowMs = input.nowMs || (() => Date.now())
  const sleep = input.sleep || defaultFenceWaitSleep
  const startedAt = nowMs()

  while (true) {
    const elapsed = Math.max(0, nowMs() - startedAt)
    const checkpoint = await input.readCheckpoint()
    const result = evaluateCloudProjectionFenceCheckpoint({
      fence: input.fence,
      checkpoint,
      nowMs: nowMs(),
      waitedMs: elapsed,
    })
    if (result.ok || !result.error.retryable) return result

    const remainingMs = input.timeoutMs - Math.max(0, nowMs() - startedAt)
    if (remainingMs <= 0) {
      return {
        ok: false,
        code: 'projection_fence_timeout',
        fence: input.fence,
        checkpoint: result.checkpoint,
        error: projectionSyncError('projection_fence_timeout', 'Timed out waiting for projection checkpoint to observe the fence.', true),
        waitedMs: Math.max(0, nowMs() - startedAt),
      }
    }
    await sleep(Math.min(intervalMs, remainingMs))
  }
}

export function createCloudAutomationEventEnvelope<Payload extends Record<string, unknown>>(input: Omit<CloudAutomationEventEnvelope<Payload>, 'version' | 'createdAt'> & { createdAt?: string }): CloudAutomationEventEnvelope<Payload> {
  const identity = assertProjectionIdentity(input)
  if (input.fence && cloudProjectionFenceIdentityKey(input.fence) !== cloudProjectionFenceIdentityKey(identity)) {
    throw new Error('Automation event fence identity must match the event identity.')
  }
  return {
    version: CLOUD_AUTOMATION_EVENT_STREAM_VERSION,
    eventId: assertExactCloudIdentity(input.eventId, 'eventId'),
    type: assertExactCloudIdentity(input.type, 'type'),
    source: input.source,
    scope: identity.scope,
    tenantId: identity.tenantId,
    ...(identity.workspaceId ? { workspaceId: identity.workspaceId } : {}),
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(identity.workflowId ? { workflowId: identity.workflowId } : {}),
    ...(identity.runId ? { runId: identity.runId } : {}),
    ...(identity.clientId ? { clientId: identity.clientId } : {}),
    sequence: assertRequiredNonNegativeInteger(input.sequence, 'sequence'),
    ...(input.projectionVersion !== undefined ? { projectionVersion: assertNonNegativeInteger(input.projectionVersion, 'projectionVersion') || 0 } : {}),
    ...(input.fence ? { fence: input.fence } : {}),
    ...(input.error ? { error: input.error } : {}),
    payload: input.payload,
    createdAt: input.createdAt || new Date().toISOString(),
  }
}

export function createCloudAutomationTerminalStatusRecord<Payload extends Record<string, unknown>>(
  event: CloudAutomationEventEnvelope<Payload>,
  emittedAt = new Date().toISOString(),
): CloudAutomationTerminalStatusRecord<Payload> {
  return {
    kind: 'open-cowork.automation.event',
    version: CLOUD_AUTOMATION_EVENT_STREAM_VERSION,
    event,
    emittedAt,
    redacted: true,
  }
}

export function formatCloudAutomationTerminalStatusLine<Payload extends Record<string, unknown>>(
  event: CloudAutomationEventEnvelope<Payload>,
  emittedAt?: string,
) {
  return JSON.stringify(createCloudAutomationTerminalStatusRecord(event, emittedAt))
}

export function parseCloudAutomationTerminalStatusLine(line: string): CloudAutomationTerminalStatusRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<CloudAutomationTerminalStatusRecord>
    if (parsed.kind !== 'open-cowork.automation.event') return null
    if (parsed.version !== CLOUD_AUTOMATION_EVENT_STREAM_VERSION) return null
    if (parsed.redacted !== true || !parsed.event) return null
    return parsed as CloudAutomationTerminalStatusRecord
  } catch {
    return null
  }
}

function projectedEntry(entry: CloudSessionEventContract): entry is CloudProjectedSessionEventContract {
  return entry.projected
}

export const CLOUD_PROJECTED_SESSION_EVENT_TYPES = CLOUD_SESSION_EVENT_CONTRACT
  .filter(projectedEntry)
  .map((entry) => entry.type) as readonly CloudProjectedSessionEventType[]

export const CLOUD_SESSION_EVENT_TYPES = CLOUD_SESSION_EVENT_CONTRACT
  .map((entry) => entry.type) as readonly CloudSessionEventType[]

const CLOUD_PROJECTED_SESSION_EVENT_TYPE_SET = new Set<string>(CLOUD_PROJECTED_SESSION_EVENT_TYPES)
const CLOUD_SESSION_EVENT_TYPE_SET = new Set<string>(CLOUD_SESSION_EVENT_TYPES)
const CLOUD_SESSION_EVENT_CONTRACT_BY_TYPE = new Map<string, CloudSessionEventContract>(
  CLOUD_SESSION_EVENT_CONTRACT.map((entry) => [entry.type, entry]),
)

export function isCloudProjectedSessionEventType(value: string): value is CloudProjectedSessionEventType {
  return CLOUD_PROJECTED_SESSION_EVENT_TYPE_SET.has(value)
}

export function isCloudSessionEventType(value: string): value is CloudSessionEventType {
  return CLOUD_SESSION_EVENT_TYPE_SET.has(value)
}

export function cloudSessionEventContractFor(type: string): CloudSessionEventContract | null {
  return CLOUD_SESSION_EVENT_CONTRACT_BY_TYPE.get(type) || null
}

export function cloudSessionEventHasFacet(type: string, facet: CloudSessionProjectionFacet) {
  const facets = cloudSessionEventContractFor(type)?.facets as readonly CloudSessionProjectionFacet[] | undefined
  return facets?.includes(facet) || false
}

export function cloudSessionEventIsChannelRenderable(type: string) {
  return cloudSessionEventContractFor(type)?.channelRenderable === true
}
