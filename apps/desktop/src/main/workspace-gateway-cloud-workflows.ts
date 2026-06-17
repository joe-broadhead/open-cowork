import type { IpcMainInvokeEvent } from 'electron'
import type {
  WorkflowDetail,
  WorkflowListPayload,
  WorkflowRun,
} from '@open-cowork/shared'
import type { CloudWorkspaceSessionAdapter } from './cloud-workspace-adapter.ts'

type WorkspaceEventLike = Pick<IpcMainInvokeEvent, 'sender'> | null | undefined

export type ResolveCloudAdapter = (
  event: WorkspaceEventLike,
  workspaceIdInput?: string | null,
) => Promise<CloudWorkspaceSessionAdapter>

export function createCloudWorkflowGateway(resolveAdapter: ResolveCloudAdapter) {
  return {
    async list(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkflowListPayload> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.listWorkflows) throw new Error('Cloud workflows are not supported by this workspace.')
      return adapter.listWorkflows()
    },

    async get(
      event: WorkspaceEventLike,
      workflowId: string,
      workspaceIdInput?: string | null,
    ): Promise<WorkflowDetail | null> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.getWorkflow) throw new Error('Cloud workflows are not supported by this workspace.')
      return adapter.getWorkflow(workflowId)
    },

    async run(
      event: WorkspaceEventLike,
      workflowId: string,
      workspaceIdInput?: string | null,
    ): Promise<WorkflowRun | null> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.runWorkflow) throw new Error('Cloud workflow runs are not supported by this workspace.')
      return adapter.runWorkflow(workflowId)
    },

    async pause(
      event: WorkspaceEventLike,
      workflowId: string,
      workspaceIdInput?: string | null,
    ): Promise<WorkflowDetail | null> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.pauseWorkflow) throw new Error('Cloud workflow pause is not supported by this workspace.')
      return adapter.pauseWorkflow(workflowId)
    },

    async resume(
      event: WorkspaceEventLike,
      workflowId: string,
      workspaceIdInput?: string | null,
    ): Promise<WorkflowDetail | null> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.resumeWorkflow) throw new Error('Cloud workflow resume is not supported by this workspace.')
      return adapter.resumeWorkflow(workflowId)
    },

    async archive(
      event: WorkspaceEventLike,
      workflowId: string,
      workspaceIdInput?: string | null,
    ): Promise<WorkflowDetail | null> {
      const adapter = await resolveAdapter(event, workspaceIdInput)
      if (!adapter.archiveWorkflow) throw new Error('Cloud workflow archive is not supported by this workspace.')
      return adapter.archiveWorkflow(workflowId)
    },
  }
}
