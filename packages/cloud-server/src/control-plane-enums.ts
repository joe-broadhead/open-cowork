import type { CloudSubscriptionStatus } from '@open-cowork/shared'

// The control-plane's string-literal enum vocabulary, extracted from the
// 4k-line in-memory store so the foundational status/role/kind unions live in
// one small, dependency-light module that the store, the Postgres store, the
// interface contract, and the route layer can all share. Pure types only.

export type ControlPlaneRole = 'owner' | 'admin' | 'member'
export type ControlPlaneMembershipStatus = 'active' | 'invited' | 'disabled'
export type ApiTokenScope = 'desktop' | 'gateway' | 'admin' | 'operator' | 'worker-internal'
export type AuditActorType = 'user' | 'api_token' | 'system'
export type ControlPlaneSessionStatus = 'idle' | 'running' | 'closed' | 'errored'
export type ControlPlaneCommandKind = 'prompt' | 'abort' | 'permission.respond' | 'question.reply' | 'question.reject'
export type ControlPlaneCommandStatus = 'pending' | 'running' | 'acked' | 'failed'
export type WorkerRole = 'all-in-one' | 'web' | 'worker' | 'scheduler'
export type WorkReaperAction = 'retried' | 'failed' | 'released'
export type HeadlessAgentStatus = 'active' | 'disabled'
export type ChannelBindingStatus = 'active' | 'disabled' | 'auth_required' | 'error'
export type ChannelIdentityRole = ControlPlaneRole | 'approver' | 'viewer'
export type ChannelIdentityStatus = 'active' | 'disabled' | 'pending'
export type ChannelSessionBindingStatus = 'active' | 'archived'
export type ChannelInteractionKind = 'permission' | 'question'
export type ChannelInteractionStatus = 'pending' | 'used' | 'expired' | 'revoked'
export type ChannelDeliveryStatus = 'pending' | 'claimed' | 'sent' | 'failed' | 'dead'
export type ByokSecretStatus = 'pending_validation' | 'active' | 'disabled' | 'expired' | 'invalid' | 'unsupported'
export type UsageEventType =
  | 'session.created'
  | 'prompt.enqueued'
  | 'work.queued'
  | 'work.claimed'
  | 'worker.execution_started'
  | 'worker.execution_completed'
  | 'worker.execution_failed'
  | 'worker.minute'
  | 'artifact.uploaded'
  | 'artifact.downloaded'
  | 'gateway.delivery.claimed'
export type UsageUnit = 'count' | 'byte' | 'minute'
export type BillingSubscriptionStatus = CloudSubscriptionStatus
