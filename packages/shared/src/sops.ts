import type {
  AutomationDeliveryProvider,
  AutomationRetryPolicy,
  AutomationRunPolicy,
} from './automation.js'

export const COWORK_SOP_SCHEMA_VERSION = 1

export type SopStatus = 'draft' | 'active' | 'paused' | 'retired'
export type SopTriggerType = 'manual' | 'schedule' | 'inbox' | 'webhook'
export type SopStepKind = 'plan' | 'execute' | 'approval' | 'evaluate' | 'deliver'

export interface SopSchemaVersionedRecord {
  schemaVersion: number
}

export interface SopRequiredInput extends SopSchemaVersionedRecord {
  id: string
  label: string
  description: string
  required: boolean
}

export interface SopWorkflowStep extends SopSchemaVersionedRecord {
  id: string
  kind: SopStepKind
  title: string
  agentName: string | null
  approvalRequired: boolean
}

export interface SopApprovalPolicy extends SopSchemaVersionedRecord {
  reviewFirst: boolean
  approvalBoundary: string | null
}

export interface SopDeliveryPolicy extends SopSchemaVersionedRecord {
  provider: AutomationDeliveryProvider
  target: string
  draftFirst: boolean
}

export interface SopDefinition extends SopSchemaVersionedRecord {
  id: string
  name: string
  description: string
  status: SopStatus
  activeVersionId: string | null
  sourceAutomationId: string | null
  createdAt: string
  updatedAt: string
}

export interface SopVersion extends SopSchemaVersionedRecord {
  id: string
  sopId: string
  version: number
  sourceAutomationId: string | null
  sourceRunId: string | null
  triggerTypes: SopTriggerType[]
  requiredInputs: SopRequiredInput[]
  workflow: SopWorkflowStep[]
  approvalPolicy: SopApprovalPolicy
  retryPolicy: AutomationRetryPolicy
  runPolicy: AutomationRunPolicy
  deliveryPolicy: SopDeliveryPolicy
  outcomeRubricId: string | null
  createdAt: string
  createdBy: string | null
}

export interface SopRunLink extends SopSchemaVersionedRecord {
  id: string
  sopId: string
  sopVersionId: string
  automationId: string
  automationRunId: string
  triggerType: SopTriggerType
  inputs: Record<string, unknown>
  createdAt: string
}

export interface SopDraft {
  name: string
  description: string
  triggerTypes: SopTriggerType[]
  requiredInputs?: SopRequiredInput[]
  workflow?: SopWorkflowStep[]
  approvalPolicy?: SopApprovalPolicy
  retryPolicy: AutomationRetryPolicy
  runPolicy: AutomationRunPolicy
  deliveryPolicy?: SopDeliveryPolicy
  outcomeRubricId?: string | null
}

export interface SopListItem {
  definition: SopDefinition
  activeVersion: SopVersion | null
}

export interface SopListPayload {
  sops: SopListItem[]
}

export interface SopDetail {
  definition: SopDefinition
  versions: SopVersion[]
  activeVersion: SopVersion | null
  runLinks: SopRunLink[]
}
