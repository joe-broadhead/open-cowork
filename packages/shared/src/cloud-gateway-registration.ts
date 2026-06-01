export const CLOUD_GATEWAY_REGISTRATION_KINDS = [
  'external_workspace',
  'edge_worker',
  'external_workspace_edge_worker',
] as const

export type CloudGatewayRegistrationKind = typeof CLOUD_GATEWAY_REGISTRATION_KINDS[number]

export const CLOUD_GATEWAY_REGISTRATION_TRUST_MODELS = [
  'self_hosted_same_operator',
  'saas_operator_managed',
  'customer_hosted_managed_saas_deferred',
] as const

export type CloudGatewayRegistrationTrustModel = typeof CLOUD_GATEWAY_REGISTRATION_TRUST_MODELS[number]

export const CLOUD_GATEWAY_REGISTRATION_CREDENTIAL_SCOPES = [
  'gateway.registration.heartbeat',
  'gateway.registration.capabilities',
  'gateway.registration.metadata_sync',
  'gateway.edge.claim',
  'gateway.edge.lease_renew',
  'gateway.edge.write_fenced_output',
] as const

export type CloudGatewayRegistrationCredentialScope = typeof CLOUD_GATEWAY_REGISTRATION_CREDENTIAL_SCOPES[number]

export const CLOUD_GATEWAY_ALLOWED_SYNC_SCOPES = [
  'health',
  'capabilities',
  'redacted_session_metadata',
  'redacted_projection_snapshot',
  'workflow_status',
  'artifact_metadata',
  'audit_summary',
  'event_cursor',
  'cloud_work_events',
  'cloud_work_projection',
  'cloud_work_artifact_metadata',
  'cloud_work_checkpoint_metadata',
] as const

export type CloudGatewayAllowedSyncScope = typeof CLOUD_GATEWAY_ALLOWED_SYNC_SCOPES[number]

export const CLOUD_GATEWAY_FORBIDDEN_SYNC_SCOPES = [
  'raw_gateway_database',
  'raw_opencode_runtime_home',
  'raw_local_paths',
  'raw_provider_keys',
  'raw_mcp_secrets',
  'raw_channel_secrets',
  'gateway_private_files',
  'cloud_byok_plaintext',
  'unfenced_event_writes',
] as const

export type CloudGatewayForbiddenSyncScope = typeof CLOUD_GATEWAY_FORBIDDEN_SYNC_SCOPES[number]

export type CloudGatewayArtifactOwnership =
  | 'gateway_retained'
  | 'cloud_owned'
  | 'split_by_work_owner'

export type CloudGatewayRegistrationContract = {
  kind: CloudGatewayRegistrationKind
  workspaceAuthority: 'gateway_standalone' | 'cloud_worker' | 'split_by_work_owner'
  runtimeAuthority: 'gateway_standalone' | 'cloud_worker' | 'split_by_work_owner'
  gatewayOwnsStandaloneSessions: boolean
  cloudOwnsCloudSessions: boolean
  cloudCanRouteEligibleWorkToGateway: boolean
  requiresManagedWorkerLeaseFencing: boolean
  customerHostedManagedSaasAllowed: boolean
  requiredCredentialScopes: CloudGatewayRegistrationCredentialScope[]
  allowedSyncScopes: CloudGatewayAllowedSyncScope[]
  forbiddenSyncScopes: CloudGatewayForbiddenSyncScope[]
  artifactOwnership: CloudGatewayArtifactOwnership
  checkpointOwnership: CloudGatewayArtifactOwnership
}

const REGISTRATION_CONTRACTS: Record<CloudGatewayRegistrationKind, CloudGatewayRegistrationContract> = {
  external_workspace: {
    kind: 'external_workspace',
    workspaceAuthority: 'gateway_standalone',
    runtimeAuthority: 'gateway_standalone',
    gatewayOwnsStandaloneSessions: true,
    cloudOwnsCloudSessions: false,
    cloudCanRouteEligibleWorkToGateway: false,
    requiresManagedWorkerLeaseFencing: false,
    customerHostedManagedSaasAllowed: true,
    requiredCredentialScopes: [
      'gateway.registration.heartbeat',
      'gateway.registration.capabilities',
      'gateway.registration.metadata_sync',
    ],
    allowedSyncScopes: [
      'health',
      'capabilities',
      'redacted_session_metadata',
      'redacted_projection_snapshot',
      'workflow_status',
      'artifact_metadata',
      'audit_summary',
      'event_cursor',
    ],
    forbiddenSyncScopes: [...CLOUD_GATEWAY_FORBIDDEN_SYNC_SCOPES],
    artifactOwnership: 'gateway_retained',
    checkpointOwnership: 'gateway_retained',
  },
  edge_worker: {
    kind: 'edge_worker',
    workspaceAuthority: 'cloud_worker',
    runtimeAuthority: 'cloud_worker',
    gatewayOwnsStandaloneSessions: false,
    cloudOwnsCloudSessions: true,
    cloudCanRouteEligibleWorkToGateway: true,
    requiresManagedWorkerLeaseFencing: true,
    customerHostedManagedSaasAllowed: false,
    requiredCredentialScopes: [
      'gateway.registration.heartbeat',
      'gateway.registration.capabilities',
      'gateway.edge.claim',
      'gateway.edge.lease_renew',
      'gateway.edge.write_fenced_output',
    ],
    allowedSyncScopes: [
      'health',
      'capabilities',
      'cloud_work_events',
      'cloud_work_projection',
      'cloud_work_artifact_metadata',
      'cloud_work_checkpoint_metadata',
      'audit_summary',
    ],
    forbiddenSyncScopes: [...CLOUD_GATEWAY_FORBIDDEN_SYNC_SCOPES],
    artifactOwnership: 'cloud_owned',
    checkpointOwnership: 'cloud_owned',
  },
  external_workspace_edge_worker: {
    kind: 'external_workspace_edge_worker',
    workspaceAuthority: 'split_by_work_owner',
    runtimeAuthority: 'split_by_work_owner',
    gatewayOwnsStandaloneSessions: true,
    cloudOwnsCloudSessions: true,
    cloudCanRouteEligibleWorkToGateway: true,
    requiresManagedWorkerLeaseFencing: true,
    customerHostedManagedSaasAllowed: false,
    requiredCredentialScopes: [
      'gateway.registration.heartbeat',
      'gateway.registration.capabilities',
      'gateway.registration.metadata_sync',
      'gateway.edge.claim',
      'gateway.edge.lease_renew',
      'gateway.edge.write_fenced_output',
    ],
    allowedSyncScopes: [
      'health',
      'capabilities',
      'redacted_session_metadata',
      'redacted_projection_snapshot',
      'workflow_status',
      'artifact_metadata',
      'event_cursor',
      'cloud_work_events',
      'cloud_work_projection',
      'cloud_work_artifact_metadata',
      'cloud_work_checkpoint_metadata',
      'audit_summary',
    ],
    forbiddenSyncScopes: [...CLOUD_GATEWAY_FORBIDDEN_SYNC_SCOPES],
    artifactOwnership: 'split_by_work_owner',
    checkpointOwnership: 'split_by_work_owner',
  },
}

export function cloudGatewayRegistrationContract(kind: CloudGatewayRegistrationKind): CloudGatewayRegistrationContract {
  return REGISTRATION_CONTRACTS[kind]
}

export function cloudGatewayRegistrationAllowsEdgeWork(
  kind: CloudGatewayRegistrationKind,
  trustModel: CloudGatewayRegistrationTrustModel,
) {
  const contract = cloudGatewayRegistrationContract(kind)
  if (!contract.cloudCanRouteEligibleWorkToGateway) return false
  return trustModel !== 'customer_hosted_managed_saas_deferred'
}
