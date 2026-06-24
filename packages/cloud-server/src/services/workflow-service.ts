import type { WorkflowWebhookAuth, WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import type { WorkflowDetail, WorkflowDraft, WorkflowListPayload, WorkflowStatus, WorkflowTriggerType } from '@open-cowork/shared'
import type { CloudPrincipal, CloudWorkflowStartResult } from '../session-service.ts'
export type CloudWorkflowWebhookInput = {
  workflowId: string
  auth: WorkflowWebhookAuth
  payload: Record<string, unknown>
  securityStore: WorkflowWebhookSecurityStore
  now?: Date
}

export type CloudWorkflowServiceDelegate = {
  listWorkflows(principal: CloudPrincipal): Promise<WorkflowListPayload>
  getWorkflow(principal: CloudPrincipal, workflowId: string): Promise<WorkflowDetail | null>
  createWorkflow(principal: CloudPrincipal, draft: WorkflowDraft): Promise<WorkflowDetail>
  updateWorkflowStatus(principal: CloudPrincipal, workflowId: string, status: WorkflowStatus): Promise<WorkflowDetail | null>
  runWorkflow(principal: CloudPrincipal, workflowId: string, input: {
    triggerType?: WorkflowTriggerType
    triggerPayload?: Record<string, unknown> | null
  }): Promise<CloudWorkflowStartResult>
  claimAndStartDueWorkflow(now?: Date, claimedBy?: string | null): Promise<CloudWorkflowStartResult | null>
  runWorkflowWebhook(input: CloudWorkflowWebhookInput): Promise<CloudWorkflowStartResult>
}

export class CloudWorkflowService {
  private readonly delegate: CloudWorkflowServiceDelegate

  constructor(delegate: CloudWorkflowServiceDelegate) {
    this.delegate = delegate
  }

  list(principal: CloudPrincipal) { return this.delegate.listWorkflows(principal) }
  get(principal: CloudPrincipal, workflowId: string) { return this.delegate.getWorkflow(principal, workflowId) }
  create(principal: CloudPrincipal, draft: WorkflowDraft) { return this.delegate.createWorkflow(principal, draft) }
  updateStatus(principal: CloudPrincipal, workflowId: string, status: WorkflowStatus) {
    return this.delegate.updateWorkflowStatus(principal, workflowId, status)
  }
  run(principal: CloudPrincipal, workflowId: string, input: { triggerType?: WorkflowTriggerType, triggerPayload?: Record<string, unknown> | null }) {
    return this.delegate.runWorkflow(principal, workflowId, input)
  }
  claimAndStartDue(now?: Date, claimedBy?: string | null) { return this.delegate.claimAndStartDueWorkflow(now, claimedBy) }
  runWebhook(input: CloudWorkflowWebhookInput) {
    return this.delegate.runWorkflowWebhook(input)
  }
}
