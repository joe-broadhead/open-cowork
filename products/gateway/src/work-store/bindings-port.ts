import {
  deleteProjectBinding,
  getChannelBinding,
  getProjectBinding,
  listProjectBindings,
  resolveProjectContext,
  updateProjectBinding,
  upsertChannelBinding,
  upsertProjectBinding,
  type ChannelBindingMode,
  type ChannelBindingRecord,
  type ProjectBindingInput,
  type ProjectBindingRecord,
  type ProjectBindingScope,
  type ProjectBindingUpdateInput,
  type ProjectContextResolution,
} from '../work-store.js'

export type WorkStoreBindingsOperationGroup =
  | 'upsert_project_binding'
  | 'mirror_channel_binding'
  | 'resolve_project_context'

export interface WorkStoreBindingsPortDomain {
  id: 'bindings'
  backendMode: 'local_sqlite'
  releaseStatus: 'supported_public_local_beta'
  operationGroups: WorkStoreBindingsOperationGroup[]
}

export interface WorkStoreProjectBindingFilter {
  alias?: string
  roadmapId?: string
  sessionId?: string
  scope?: ProjectBindingScope
  provider?: string
  chatId?: string
  threadId?: string
}

export interface WorkStoreProjectContextInput {
  alias?: string
  roadmapId?: string
  provider?: string
  chatId?: string
  threadId?: string
  sessionId?: string
}

export interface WorkStoreChannelBindingInput {
  provider: string
  chatId: string
  threadId?: string
  sessionId: string
  mode?: ChannelBindingMode
  roadmapId?: string
  taskId?: string
  title?: string
}

export interface WorkStoreBindingsPort {
  readonly domain: WorkStoreBindingsPortDomain
  listProjectBindings(filter?: WorkStoreProjectBindingFilter): ProjectBindingRecord[]
  getProjectBinding(id: string): ProjectBindingRecord | undefined
  upsertProjectBinding(input: ProjectBindingInput): ProjectBindingRecord
  updateProjectBinding(id: string, input: ProjectBindingUpdateInput): ProjectBindingRecord | undefined
  deleteProjectBinding(id: string): boolean
  resolveProjectContext(input: WorkStoreProjectContextInput): ProjectContextResolution
  getChannelBinding(provider: string, chatId: string, threadId?: string): ChannelBindingRecord | undefined
  upsertChannelBinding(input: WorkStoreChannelBindingInput): ChannelBindingRecord
}

export const WORK_STORE_BINDINGS_PORT_DOMAIN: WorkStoreBindingsPortDomain = {
  id: 'bindings',
  backendMode: 'local_sqlite',
  releaseStatus: 'supported_public_local_beta',
  operationGroups: ['upsert_project_binding', 'mirror_channel_binding', 'resolve_project_context'],
}

export function createSqliteWorkStoreBindingsPort(options: { filePath?: string } = {}): WorkStoreBindingsPort {
  const filePath = options.filePath
  return {
    domain: {
      ...WORK_STORE_BINDINGS_PORT_DOMAIN,
      operationGroups: [...WORK_STORE_BINDINGS_PORT_DOMAIN.operationGroups],
    },
    listProjectBindings(filter = {}) {
      return listProjectBindings(filter, filePath)
    },
    getProjectBinding(id) {
      return getProjectBinding(id, filePath)
    },
    upsertProjectBinding(input) {
      return upsertProjectBinding(input, filePath)
    },
    updateProjectBinding(id, input) {
      return updateProjectBinding(id, input, filePath)
    },
    deleteProjectBinding(id) {
      return deleteProjectBinding(id, filePath)
    },
    resolveProjectContext(input) {
      return resolveProjectContext(input, filePath)
    },
    getChannelBinding(provider, chatId, threadId) {
      return getChannelBinding(provider, chatId, threadId, filePath)
    },
    upsertChannelBinding(input) {
      return upsertChannelBinding(input, filePath)
    },
  }
}
