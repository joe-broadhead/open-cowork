import type { RuntimeStatus } from './runtime.js'
import type { CanonicalResourceIdentity, ResourceAuthority } from './resource-identity.js'

export const SEMANTIC_UI_CONTRACT_VERSION = 1

export type SemanticUiReadOnlyTool = 'ui_status' | 'ui_snapshot'
export type SemanticUiActionTool = 'ui_list_actions' | 'ui_execute_action'
export type SemanticUiToolName = SemanticUiReadOnlyTool | SemanticUiActionTool

export interface SemanticUiBridgeConfig {
  enabled: boolean
  authority: ResourceAuthority
  tokenHash?: string | null
  allowActions?: boolean
}

export interface SemanticUiAuthorizationInput {
  config: SemanticUiBridgeConfig
  tool: SemanticUiToolName
  presentedTokenHash?: string | null
}

export interface SemanticUiAuthorizationDecision {
  allowed: boolean
  reasonCode:
    | 'semantic-ui-disabled'
    | 'semantic-ui-token-required'
    | 'semantic-ui-token-mismatch'
    | 'semantic-ui-actions-not-implemented'
    | 'semantic-ui-read-only-allowed'
    | 'semantic-ui-action-allowed'
}

export interface SemanticUiPendingCounts {
  approvals: number
  questions: number
}

export interface SemanticUiStatus {
  schemaVersion: typeof SEMANTIC_UI_CONTRACT_VERSION
  capturedAt: string
  authority: ResourceAuthority
  appReady: boolean
  route: CanonicalResourceIdentity | null
  workspace: CanonicalResourceIdentity | null
  activeSession: CanonicalResourceIdentity | null
  runtime: Pick<RuntimeStatus, 'ready' | 'phase' | 'error' | 'updatedAt'>
  pending: SemanticUiPendingCounts
  redacted: true
}

export interface SemanticUiSnapshotItem {
  id: string
  kind: 'navigation' | 'session' | 'workflow' | 'approval' | 'question' | 'diagnostics' | 'capability' | 'status'
  label: string
  identity?: CanonicalResourceIdentity
  state?: string
}

export interface SemanticUiSnapshot {
  schemaVersion: typeof SEMANTIC_UI_CONTRACT_VERSION
  capturedAt: string
  status: SemanticUiStatus
  visibleSurface: string
  items: SemanticUiSnapshotItem[]
  redacted: true
}

export type SemanticUiActionId =
  | 'diagnostics.export'
  | 'approval.allow'
  | 'approval.deny'
  | 'question.answer'
  | 'question.reject'

export interface SemanticUiActionDefinition {
  id: SemanticUiActionId
  label: string
  description: string
  destructive: boolean
  requiresAudit: boolean
  enabled: boolean
  reasonCode?: string
  auditEventType?: string
}

export interface SemanticUiActionList {
  schemaVersion: typeof SEMANTIC_UI_CONTRACT_VERSION
  capturedAt: string
  actions: SemanticUiActionDefinition[]
  redacted: true
}

export interface SemanticUiActionResult {
  schemaVersion: typeof SEMANTIC_UI_CONTRACT_VERSION
  capturedAt: string
  actionId: SemanticUiActionId
  ok: boolean
  content?: unknown
  errorCode?: string
  message?: string
  redacted: true
}

export interface SemanticUiAppState {
  capturedAt?: string
  authority: ResourceAuthority
  appReady?: boolean
  route?: CanonicalResourceIdentity | null
  workspace?: CanonicalResourceIdentity | null
  activeSession?: CanonicalResourceIdentity | null
  runtime?: Pick<RuntimeStatus, 'ready' | 'phase' | 'error' | 'updatedAt'>
  pending?: Partial<SemanticUiPendingCounts>
  visibleSurface?: string
  items?: SemanticUiSnapshotItem[]
}

const SECRET_TEXT_PATTERNS = [
  /\bAuthorization:\s*(?:Bearer|Basic)\s+\S+/gi,
  /\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{16,}['"]?/gi,
  /\b(?:gh[pousr]_|github_pat_|sk-|sk-or-|sk-ant-|hf_)[A-Za-z0-9._-]{12,}\b/g,
  /\/Users\/[^\s"'`:]+/g,
  /\/home\/[^\s"'`:]+/g,
]

function redactSemanticUiText(value: string) {
  return SECRET_TEXT_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[redacted]'), value).slice(0, 240)
}

export function authorizeSemanticUiTool(input: SemanticUiAuthorizationInput): SemanticUiAuthorizationDecision {
  if (!input.config.enabled) return { allowed: false, reasonCode: 'semantic-ui-disabled' }
  if (!input.config.tokenHash) return { allowed: false, reasonCode: 'semantic-ui-token-required' }
  if (input.presentedTokenHash !== input.config.tokenHash) return { allowed: false, reasonCode: 'semantic-ui-token-mismatch' }
  if (input.tool === 'ui_status' || input.tool === 'ui_snapshot') {
    return { allowed: true, reasonCode: 'semantic-ui-read-only-allowed' }
  }
  if (!input.config.allowActions) {
    return { allowed: false, reasonCode: 'semantic-ui-actions-not-implemented' }
  }
  return { allowed: true, reasonCode: 'semantic-ui-action-allowed' }
}

export function createSemanticUiStatus(input: Omit<SemanticUiStatus, 'schemaVersion' | 'redacted'>): SemanticUiStatus {
  return {
    ...input,
    runtime: {
      ready: input.runtime.ready,
      phase: input.runtime.phase,
      error: input.runtime.error ? redactSemanticUiText(input.runtime.error) : input.runtime.error,
      updatedAt: input.runtime.updatedAt,
    },
    pending: {
      approvals: Math.max(0, Math.trunc(input.pending.approvals)),
      questions: Math.max(0, Math.trunc(input.pending.questions)),
    },
    schemaVersion: SEMANTIC_UI_CONTRACT_VERSION,
    redacted: true,
  }
}

export function createSemanticUiSnapshot(input: Omit<SemanticUiSnapshot, 'schemaVersion' | 'redacted'>): SemanticUiSnapshot {
  return {
    ...input,
    visibleSurface: redactSemanticUiText(input.visibleSurface),
    items: input.items.slice(0, 200).map((item) => ({
      ...item,
      id: redactSemanticUiText(item.id),
      label: redactSemanticUiText(item.label),
      state: item.state ? redactSemanticUiText(item.state) : item.state,
    })),
    schemaVersion: SEMANTIC_UI_CONTRACT_VERSION,
    redacted: true,
  }
}

export function createSemanticUiActionList(input: Omit<SemanticUiActionList, 'schemaVersion' | 'redacted'>): SemanticUiActionList {
  return {
    ...input,
    actions: input.actions.slice(0, 100).map((action) => ({
      ...action,
      label: redactSemanticUiText(action.label),
      description: redactSemanticUiText(action.description),
      reasonCode: action.reasonCode ? redactSemanticUiText(action.reasonCode) : undefined,
      auditEventType: action.auditEventType ? redactSemanticUiText(action.auditEventType) : undefined,
    })),
    schemaVersion: SEMANTIC_UI_CONTRACT_VERSION,
    redacted: true,
  }
}

export function createSemanticUiActionResult(input: Omit<SemanticUiActionResult, 'schemaVersion' | 'redacted'>): SemanticUiActionResult {
  return {
    ...input,
    message: input.message ? redactSemanticUiText(input.message) : input.message,
    schemaVersion: SEMANTIC_UI_CONTRACT_VERSION,
    redacted: true,
  }
}
