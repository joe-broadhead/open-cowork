import type { WorkflowDraft, WorkflowToolCreateResult } from '@open-cowork/shared'
import {
  createWorkflow,
  previewWorkflowDraft,
} from './workflow-store.ts'
import { getWorkflowWebhookBaseUrl } from './workflow-webhook-server.ts'

let publishWorkflowUpdated: (() => void) | null = null

export function configureWorkflowToolActions(options: { publishWorkflowUpdated: () => void }) {
  publishWorkflowUpdated = options.publishWorkflowUpdated
}

export function previewWorkflowFromTool(draft: WorkflowDraft) {
  return previewWorkflowDraft(draft)
}

export function createWorkflowFromTool(draft: WorkflowDraft): WorkflowToolCreateResult {
  const workflow = createWorkflow(draft, getWorkflowWebhookBaseUrl())
  publishWorkflowUpdated?.()
  return { ok: true, workflow }
}
