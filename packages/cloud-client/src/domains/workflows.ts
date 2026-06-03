export type {
  WorkflowDetail,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowTriggerType,
} from '../contracts.js'

import type {
  WorkflowDetail,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowTriggerType,
} from '../contracts.js'
import type { CloudDomainClientContext } from './shared.js'
import { encodePath } from './shared.js'

export type CloudWorkflowsClient = {
  listWorkflows(): Promise<WorkflowListPayload>
  getWorkflow(workflowId: string): Promise<WorkflowDetail | null>
  runWorkflow(workflowId: string, input?: { triggerType?: WorkflowTriggerType, triggerPayload?: Record<string, unknown> | null }): Promise<WorkflowRun | null>
  pauseWorkflow(workflowId: string): Promise<WorkflowDetail | null>
  resumeWorkflow(workflowId: string): Promise<WorkflowDetail | null>
  archiveWorkflow(workflowId: string): Promise<WorkflowDetail | null>
}

export function createCloudWorkflowsClient({ request }: CloudDomainClientContext): CloudWorkflowsClient {
  return {
    listWorkflows() {
      return request<WorkflowListPayload>('/api/workflows')
    },
    async getWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}`)).workflow
    },
    async runWorkflow(workflowId, input = {}) {
      return (await request<{ run: WorkflowRun | null }>(`/api/workflows/${encodePath(workflowId)}/run`, {
        method: 'POST',
        body: input,
      })).run
    },
    async pauseWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}/pause`, {
        method: 'POST',
        body: {},
      })).workflow
    },
    async resumeWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}/resume`, {
        method: 'POST',
        body: {},
      })).workflow
    },
    async archiveWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}/archive`, {
        method: 'POST',
        body: {},
      })).workflow
    },
  }
}
