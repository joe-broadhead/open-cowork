import type { ControlPlaneStore } from '../control-plane-store.ts'

export type WorkflowControlPlaneStore = Pick<ControlPlaneStore,
  | 'createWorkflow'
  | 'findWorkflow'
  | 'listWorkflows'
  | 'getWorkflow'
  | 'getWorkflowForTenant'
  | 'updateWorkflowStatus'
  | 'listWorkflowRuns'
  | 'createWorkflowRun'
  | 'claimDueWorkflowRun'
  | 'reapExpiredWorkflowClaims'
  | 'attachWorkflowRunSession'
  | 'completeWorkflowRun'
  | 'failWorkflowRun'
  | 'getWorkflowRun'
  | 'getWorkflowRunBySession'
>
