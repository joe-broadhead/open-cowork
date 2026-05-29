import type { ControlPlaneStore } from './control-plane-store.ts'

export type IdentityControlPlaneStore = Pick<ControlPlaneStore,
  | 'createTenant'
  | 'ensureUser'
  | 'ensureOrgForTenant'
  | 'createAccount'
  | 'findAccountBySubject'
  | 'findAccountByEmail'
  | 'upsertMembership'
  | 'listMembershipsForAccount'
  | 'resolvePrincipalMembership'
  | 'recordAuditEvent'
  | 'listAuditEvents'
>

export type ApiTokenControlPlaneStore = Pick<ControlPlaneStore,
  | 'issueApiToken'
  | 'listApiTokens'
  | 'findApiTokenByPlaintext'
  | 'revokeApiToken'
>

export type BillingControlPlaneStore = Pick<ControlPlaneStore,
  | 'upsertBillingSubscription'
  | 'getBillingSubscription'
  | 'findBillingSubscriptionByProvider'
>

export type QuotaControlPlaneStore = Pick<ControlPlaneStore,
  | 'consumeUsageQuota'
  | 'recordUsageEvent'
  | 'listUsageEvents'
  | 'claimRateLimit'
  | 'checkCloudAuthBackoff'
  | 'recordCloudAuthFailure'
>

export type ByokControlPlaneStore = Pick<ControlPlaneStore,
  | 'createByokSecret'
  | 'getByokSecret'
  | 'getActiveByokSecret'
  | 'listByokSecrets'
  | 'disableByokSecret'
  | 'recordByokSecretValidation'
>

export type ChannelControlPlaneStore = Pick<ControlPlaneStore,
  | 'createHeadlessAgent'
  | 'updateHeadlessAgent'
  | 'getHeadlessAgent'
  | 'listHeadlessAgents'
  | 'createChannelBinding'
  | 'updateChannelBinding'
  | 'getChannelBinding'
  | 'listChannelBindings'
  | 'upsertChannelIdentity'
  | 'getChannelIdentity'
  | 'findChannelIdentity'
  | 'bindChannelSession'
  | 'getChannelSessionBinding'
  | 'findChannelSessionBindingByThread'
  | 'listChannelSessionBindingsForSession'
  | 'updateChannelCursor'
  | 'createChannelInteraction'
  | 'findChannelInteraction'
  | 'resolveChannelInteraction'
  | 'resolveChannelInteractionWithCommand'
  | 'createChannelDelivery'
  | 'listChannelDeliveries'
  | 'claimNextChannelDelivery'
  | 'ackChannelDelivery'
>

export type SessionControlPlaneStore = Pick<ControlPlaneStore,
  | 'createSession'
  | 'getSession'
  | 'getSessionForTenant'
  | 'findSession'
  | 'listSessions'
  | 'listAllSessions'
  | 'bindSessionRuntime'
  | 'updateSessionStatus'
  | 'appendSessionEvent'
  | 'listSessionEvents'
  | 'appendWorkspaceEvent'
  | 'listWorkspaceEvents'
  | 'writeSessionProjection'
  | 'getSessionProjection'
  | 'claimSessionLease'
  | 'renewSessionLease'
  | 'checkpointSession'
  | 'enqueueSessionCommand'
  | 'claimNextSessionCommand'
  | 'ackSessionCommand'
  | 'failSessionCommand'
  | 'recordWorkerHeartbeat'
  | 'listWorkerHeartbeats'
>

export type ProjectionControlPlaneStore = Pick<SessionControlPlaneStore,
  | 'appendSessionEvent'
  | 'getSessionForTenant'
  | 'appendWorkspaceEvent'
  | 'getSessionProjection'
  | 'writeSessionProjection'
>

export type SettingsControlPlaneStore = Pick<ControlPlaneStore,
  | 'setSettingMetadata'
  | 'getSettingMetadata'
  | 'listSettingMetadata'
>

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
  | 'attachWorkflowRunSession'
  | 'completeWorkflowRun'
  | 'failWorkflowRun'
  | 'getWorkflowRun'
  | 'getWorkflowRunBySession'
>

export type ThreadIndexControlPlaneStore = Pick<ControlPlaneStore,
  | 'listThreadTags'
  | 'createThreadTag'
  | 'updateThreadTag'
  | 'deleteThreadTag'
  | 'applyThreadTags'
  | 'removeThreadTags'
  | 'listThreadSmartFilters'
  | 'createThreadSmartFilter'
  | 'updateThreadSmartFilter'
  | 'deleteThreadSmartFilter'
  | 'listThreadMetadata'
>

export type SchemaMigrationControlPlaneStore = Pick<ControlPlaneStore,
  | 'recordSchemaMigration'
  | 'listSchemaMigrations'
>

export type CloudControlPlaneDomains =
  & IdentityControlPlaneStore
  & ApiTokenControlPlaneStore
  & BillingControlPlaneStore
  & QuotaControlPlaneStore
  & ByokControlPlaneStore
  & ChannelControlPlaneStore
  & SessionControlPlaneStore
  & SettingsControlPlaneStore
  & WorkflowControlPlaneStore
  & ThreadIndexControlPlaneStore
  & SchemaMigrationControlPlaneStore
