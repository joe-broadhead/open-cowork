export const CLOUD_SESSION_PROJECTION_CONTRACT_VERSION = 1

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
