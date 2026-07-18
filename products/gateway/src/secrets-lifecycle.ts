import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import type { GatewayConfig } from './config.js'

const MAX_SCOPED_HTTP_TOKEN_FILE_BYTES = 8 * 1024

export type SecretProvider = 'gateway_http' | 'telegram' | 'whatsapp' | 'discord' | 'opencode' | 'mcp' | 'worker'

export type SecretInputClass =
  | 'http_bearer_token'
  | 'provider_token'
  | 'webhook_secret'
  | 'provider_identifier'
  | 'verification_key'
  | 'model_provider_key'
  | 'mcp_credential'
  | 'future_worker_secret'

export type SecretStorageMode =
  | 'environment'
  | 'local_config'
  | 'opencode_config'
  | 'external_provider'
  | 'future_vault'
  | 'not_gateway_managed'

export type SecretOwner = 'local_operator' | 'opencode' | 'provider' | 'future_vault'

export type SecretReferenceId = `secretref_${string}`
export type SecretReferenceSource = 'environment' | 'local_config'
export type SecretScopeKind = 'system' | 'workspace' | 'project' | 'channel' | 'connector' | 'mcp' | 'worker' | 'provider'
export type SecretRotationPosture = 'operator_managed' | 'provider_managed' | 'opencode_managed' | 'future_vault_required'
export type SecretRotationHealth = 'healthy' | 'due' | 'overdue' | 'blocked' | 'unsupported'
export type SecretRevocationState = 'active' | 'revoked' | 'unsupported'
export type SecretInjectionContextKind = 'http' | 'channel' | 'connector' | 'mcp' | 'opencode' | 'subprocess' | 'worker'

export interface SecretReferenceScope {
  kind: SecretScopeKind
  path: string
  provider?: SecretProvider
  projectScoped: boolean
  workerScoped: boolean
}

export interface SecretReference {
  id: SecretReferenceId
  inputId: string
  label: string
  class: SecretInputClass
  secret: boolean
  owner: SecretOwner
  provider?: SecretProvider
  source: SecretReferenceSource
  storageMode: Extract<SecretStorageMode, 'environment' | 'local_config'>
  location: string
  envName?: string
  configKey?: string
  scope: SecretReferenceScope
  injection: {
    destination: string
    sourceEnvNames: string[]
    exportEnvNames: string[]
    allowedContextKinds: SecretInjectionContextKind[]
    valueAvailable: boolean
  }
  lastSeen: {
    configured: true
    source: SecretReferenceSource
    location: string
  }
  rotation: {
    posture: SecretRotationPosture
    health: SecretRotationHealth
    lastVerifiedAt?: string
    nextAction: string
    rotationPlan: string
    revocationPlan: string
  }
  revocation: {
    state: SecretRevocationState
    revokedAt?: string
    reason?: string
    plan: string
  }
  redaction: {
    valueExposed: false
    exactMatch: boolean
    safeLabel: string
    policy: string
  }
  capability: string
  audit: {
    redacted: true
    eventTypes: string[]
  }
}

export interface SecretVaultResolution {
  ok: boolean
  referenceId: SecretReferenceId
  value?: string
  reference?: SecretReference
  reason?: string
}

export interface SecretInjectionContext {
  kind: SecretInjectionContextKind
  provider?: SecretProvider
  projectId?: string
  workerId?: string
  leaseId?: string
}

export interface ScopedSecretInjectionRequest {
  context: SecretInjectionContext
  referenceIds: SecretReferenceId[]
  allowEnv: string[]
  baseEnv?: Record<string, string>
}

export interface ScopedSecretInjectionDenial {
  referenceId?: SecretReferenceId
  code:
    | 'overbroad_allowlist'
    | 'unknown_reference'
    | 'context_not_allowed'
    | 'provider_scope_mismatch'
    | 'project_scope_required'
    | 'worker_scope_required'
    | 'reference_revoked'
    | 'rotation_stale'
    | 'env_not_allowlisted'
    | 'value_unavailable'
    | 'unknown_allowlisted_env'
  reason: string
}

export interface ScopedSecretInjectionResult {
  allowed: boolean
  env: Record<string, string>
  injected: Array<{
    referenceId: SecretReferenceId
    inputId: string
    envName: string
    source: SecretReferenceSource
    scope: SecretReferenceScope
  }>
  denied: ScopedSecretInjectionDenial[]
}

export interface SecretInputDefinition {
  id: string
  label: string
  provider?: SecretProvider
  class: SecretInputClass
  secret: boolean
  exactMatchRedaction: boolean
  owner: SecretOwner
  env: string[]
  configKeys: string[]
  currentStorageModes: SecretStorageMode[]
  injectionPath: string
  redactionPolicy: string
  rotationPlan: string
  revocationPlan: string
  failureMode: string
  futureVaultScope: string
}

export interface ConfiguredSecretInput {
  id: string
  class: SecretInputClass
  secret: boolean
  configuredVia: Array<'environment' | 'local_config'>
  env: string[]
  configKeys: string[]
  referenceIds: SecretReferenceId[]
}

export interface SecretLifecycleRisk {
  code: string
  severity: 'warning' | 'critical'
  inputId: string
  summary: string
  remediation: string
}

export interface SecretsLifecycleReport {
  mode: 'local_operator_managed'
  releaseStatus: 'supported_public_local_beta'
  vaultStatus: 'local_reference_adapter_preview'
  hostedTeamStatus: 'unsupported_until_m25_decision'
  teamPreviewStatus: 'bounded_scoped_injection_preview'
  rawSecretPolicy: 'never_in_durable_work_or_evidence'
  scopedInjection: {
    implemented: true
    defaultPolicy: 'deny_unknown_or_overbroad_requests'
    rawValuePolicy: 'in_memory_only'
    providerScopeEnforced: true
    revokedReferencesDenied: true
    staleRotationDenied: true
    supportedContexts: SecretInjectionContextKind[]
  }
  totals: {
    inventoryItems: number
    secretInputs: number
    providerIdentifiers: number
    environmentBackedInputs: number
    localConfigBackedInputs: number
    opencodeOwnedInputs: number
    futureVaultBackedInputs: number
    configuredReferences: number
    injectableReferences: number
  }
  configuredInputs: ConfiguredSecretInput[]
  secretReferences: SecretReference[]
  operatorPosture: SecretLifecycleOperatorPosture
  auditEventTypes: string[]
  risks: SecretLifecycleRisk[]
  caveats: string[]
}

export interface SecretLifecycleOperatorPosture {
  mode: 'local_and_team_preview_secret_lifecycle'
  redacted: true
  rotationHealth: Record<SecretRotationHealth, number>
  revocation: Record<SecretRevocationState, number>
  injectionGuardrails: {
    failClosed: true
    exactReferences: true
    exactEnvAllowlist: true
    contextKindEnforced: true
    providerScopeEnforced: true
    projectScopeRequired: true
    workerLeaseRequired: true
    revokedReferencesDenied: true
    staleRotationDenied: true
    valuesInMemoryOnly: true
  }
  evidencePolicy: {
    redacted: true
    allowedFields: string[]
    forbiddenFields: string[]
  }
  references: Array<{
    id: SecretReferenceId
    inputId: string
    label: string
    class: SecretInputClass
    owner: SecretOwner
    provider?: SecretProvider
    source: SecretReferenceSource
    scope: SecretReferenceScope
    capability: string
    rotation: Pick<SecretReference['rotation'], 'posture' | 'health' | 'lastVerifiedAt' | 'nextAction'>
    revocation: SecretReference['revocation']
    injection: Pick<SecretReference['injection'], 'destination' | 'exportEnvNames' | 'allowedContextKinds' | 'valueAvailable'>
    redaction: SecretReference['redaction']
  }>
  nextActions: string[]
}

export const SECRET_INPUT_INVENTORY: SecretInputDefinition[] = [
  {
    id: 'gateway_http_read_token',
    label: 'Gateway scoped read HTTP token',
    provider: 'gateway_http',
    class: 'http_bearer_token',
    secret: true,
    exactMatchRedaction: true,
    owner: 'local_operator',
    env: ['OPENCODE_GATEWAY_HTTP_READ_TOKEN'],
    configKeys: [],
    currentStorageModes: ['environment'],
    injectionPath: 'Read by HTTP security middleware to authorize read routes.',
    redactionPolicy: 'Bearer values and configured token values are redacted.',
    rotationPlan: 'Generate a replacement scoped token, deploy it to callers, restart Gateway if needed, then revoke the old value.',
    revocationPlan: 'Unset the environment variable and remove it from clients/reverse proxies.',
    failureMode: 'Read-only exposed routes reject callers without a valid read/operator/asset/admin token.',
    futureVaultScope: 'system/http/read',
  },
  {
    id: 'gateway_http_operator_token',
    label: 'Gateway scoped operator HTTP token',
    provider: 'gateway_http',
    class: 'http_bearer_token',
    secret: true,
    exactMatchRedaction: true,
    owner: 'local_operator',
    env: ['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'],
    configKeys: [],
    currentStorageModes: ['environment'],
    injectionPath: 'Read by HTTP security middleware to authorize durable work mutation routes.',
    redactionPolicy: 'Bearer values and configured token values are redacted.',
    rotationPlan: 'Generate replacement operator token, update trusted clients, restart Gateway if needed, then revoke old value.',
    revocationPlan: 'Unset the environment variable and remove it from trusted clients.',
    failureMode: 'Operator routes deny missing or under-scoped bearer tokens in exposed HTTP mode.',
    futureVaultScope: 'system/http/operator',
  },
  {
    id: 'gateway_http_admin_token',
    label: 'Gateway scoped admin HTTP token',
    provider: 'gateway_http',
    class: 'http_bearer_token',
    secret: true,
    exactMatchRedaction: true,
    owner: 'local_operator',
    env: ['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'],
    configKeys: [],
    currentStorageModes: ['environment'],
    injectionPath: 'Read by HTTP security middleware to authorize admin routes.',
    redactionPolicy: 'Bearer values and configured token values are redacted.',
    rotationPlan: 'Rotate with a short maintenance window; validate admin access and remove old token immediately.',
    revocationPlan: 'Unset the environment variable and remove it from admin clients/reverse proxies.',
    failureMode: 'Admin routes deny missing tokens; unsafe public no-auth mode remains a critical readiness failure.',
    futureVaultScope: 'system/http/admin',
  },
  {
    id: 'gateway_http_asset_write_token',
    label: 'Gateway scoped OpenCode asset-write HTTP token',
    provider: 'gateway_http',
    class: 'http_bearer_token',
    secret: true,
    exactMatchRedaction: true,
    owner: 'local_operator',
    env: ['OPENCODE_GATEWAY_HTTP_ASSET_WRITE_TOKEN'],
    configKeys: [],
    currentStorageModes: ['environment'],
    injectionPath: 'Read by HTTP security middleware to authorize OpenCode asset mutation routes.',
    redactionPolicy: 'Bearer values and configured token values are redacted.',
    rotationPlan: 'Rotate alongside any automation that mutates OpenCode assets.',
    revocationPlan: 'Unset the environment variable and remove from automation clients.',
    failureMode: 'Asset-write routes deny missing or under-scoped tokens in exposed HTTP mode.',
    futureVaultScope: 'system/http/asset_write',
  },
  {
    id: 'gateway_http_webhook_token',
    label: 'Gateway scoped webhook HTTP token',
    provider: 'gateway_http',
    class: 'http_bearer_token',
    secret: true,
    exactMatchRedaction: true,
    owner: 'local_operator',
    env: ['OPENCODE_GATEWAY_HTTP_WEBHOOK_TOKEN'],
    configKeys: [],
    currentStorageModes: ['environment'],
    injectionPath: 'Read by HTTP security middleware for authenticated webhook ingress when public webhook mode is not used.',
    redactionPolicy: 'Bearer values and configured token values are redacted.',
    rotationPlan: 'Rotate through reverse proxy/provider callback configuration before revoking the old value.',
    revocationPlan: 'Unset the environment variable and remove it from the ingress proxy/provider configuration.',
    failureMode: 'Webhook routes deny missing tokens unless explicitly public webhook mode is enabled for documented provider routes.',
    futureVaultScope: 'system/http/webhook',
  },
  {
    id: 'telegram_bot_token',
    label: 'Telegram bot token',
    provider: 'telegram',
    class: 'provider_token',
    secret: true,
    exactMatchRedaction: true,
    owner: 'local_operator',
    env: ['TELEGRAM_BOT_TOKEN'],
    configKeys: ['channels.telegram.botToken'],
    currentStorageModes: ['environment', 'local_config'],
    injectionPath: 'Read by the Telegram adapter for getMe, polling, sendMessage, rich sends, command registration, and callback handling.',
    redactionPolicy: 'Known configured token values, Telegram token patterns, logs, channel diagnostics, and evidence exports are redacted.',
    rotationPlan: 'Regenerate with BotFather, update env/config, restart Gateway, verify startup, then revoke the old token.',
    revocationPlan: 'Revoke/regenerate in BotFather and remove the old env/config value.',
    failureMode: 'Telegram connector remains not configured or degraded; configured providers still require trusted targets before privileged actions.',
    futureVaultScope: 'project/channel/telegram/bot_token',
  },
  {
    id: 'whatsapp_access_token',
    label: 'WhatsApp Cloud API access token',
    provider: 'whatsapp',
    class: 'provider_token',
    secret: true,
    exactMatchRedaction: true,
    owner: 'local_operator',
    env: ['WHATSAPP_ACCESS_TOKEN'],
    configKeys: ['channels.whatsapp.accessToken'],
    currentStorageModes: ['environment', 'local_config'],
    injectionPath: 'Read by the WhatsApp adapter for Cloud API outbound sends.',
    redactionPolicy: 'Configured values and bearer/token patterns are redacted from diagnostics, logs, and evidence.',
    rotationPlan: 'Rotate the Meta app/system-user token, update env/config, restart Gateway, and verify send health.',
    revocationPlan: 'Revoke the Meta token and remove the local env/config value.',
    failureMode: 'WhatsApp outbound sends fail and connector readiness stays credentials_needed or degraded.',
    futureVaultScope: 'project/channel/whatsapp/access_token',
  },
  {
    id: 'whatsapp_phone_number_id',
    label: 'WhatsApp phone number ID',
    provider: 'whatsapp',
    class: 'provider_identifier',
    secret: false,
    exactMatchRedaction: true,
    owner: 'provider',
    env: ['WHATSAPP_PHONE_NUMBER_ID'],
    configKeys: ['channels.whatsapp.phoneNumberId'],
    currentStorageModes: ['environment', 'local_config', 'external_provider'],
    injectionPath: 'Read by the WhatsApp adapter to address Cloud API send endpoints.',
    redactionPolicy: 'Treated as a private provider target; evidence and diagnostics should show only key presence or hashed/redacted references.',
    rotationPlan: 'Change only when the Meta phone asset changes; update env/config and binding evidence.',
    revocationPlan: 'Remove the local value and deprovision the Meta phone asset if no longer trusted.',
    failureMode: 'WhatsApp outbound sends cannot address the provider endpoint.',
    futureVaultScope: 'project/channel/whatsapp/provider_asset',
  },
  {
    id: 'whatsapp_verify_token',
    label: 'WhatsApp webhook verify token',
    provider: 'whatsapp',
    class: 'webhook_secret',
    secret: true,
    exactMatchRedaction: true,
    owner: 'local_operator',
    env: ['WHATSAPP_VERIFY_TOKEN'],
    configKeys: ['channels.whatsapp.verifyToken'],
    currentStorageModes: ['environment', 'local_config'],
    injectionPath: 'Read by the WhatsApp webhook verifier for Meta challenge validation.',
    redactionPolicy: 'Configured values and token key/value patterns are redacted.',
    rotationPlan: 'Choose a new local random value, update Meta webhook config and env/config, then re-run webhook verification.',
    revocationPlan: 'Remove the old value from Meta webhook settings and local env/config.',
    failureMode: 'Meta webhook challenge verification fails.',
    futureVaultScope: 'project/channel/whatsapp/verify_token',
  },
  {
    id: 'whatsapp_app_secret',
    label: 'WhatsApp app secret',
    provider: 'whatsapp',
    class: 'webhook_secret',
    secret: true,
    exactMatchRedaction: true,
    owner: 'local_operator',
    env: ['WHATSAPP_APP_SECRET'],
    configKeys: ['channels.whatsapp.appSecret'],
    currentStorageModes: ['environment', 'local_config'],
    injectionPath: 'Read by the WhatsApp adapter to verify signed inbound webhook payloads.',
    redactionPolicy: 'Configured values, signatures, and app-secret-like keys are redacted from diagnostics and evidence.',
    rotationPlan: 'Rotate in Meta app settings, update env/config, restart Gateway, and verify signed webhook delivery.',
    revocationPlan: 'Rotate/revoke in Meta and remove the old env/config value.',
    failureMode: 'Inbound POST signatures cannot be verified; connector readiness should remain blocked or degraded.',
    futureVaultScope: 'project/channel/whatsapp/app_secret',
  },
  {
    id: 'discord_alpha_enabled',
    label: 'Discord private alpha enablement flag',
    provider: 'discord',
    class: 'provider_identifier',
    secret: false,
    exactMatchRedaction: false,
    owner: 'local_operator',
    env: ['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'],
    configKeys: ['channels.discord.enabled'],
    currentStorageModes: ['environment', 'local_config'],
    injectionPath: 'Read by the Discord adapter and connector status to decide whether the alpha adapter is active.',
    redactionPolicy: 'Not secret, but evidence should record alpha posture without implying production promotion.',
    rotationPlan: 'Not rotated; disable when alpha proof is no longer needed.',
    revocationPlan: 'Unset env/config and restart Gateway.',
    failureMode: 'Discord remains disabled or explicitly alpha-only.',
    futureVaultScope: 'workspace/channel/discord/enablement',
  },
  {
    id: 'discord_bot_token',
    label: 'Discord bot token',
    provider: 'discord',
    class: 'provider_token',
    secret: true,
    exactMatchRedaction: true,
    owner: 'local_operator',
    env: ['DISCORD_BOT_TOKEN'],
    configKeys: ['channels.discord.botToken'],
    currentStorageModes: ['environment', 'local_config'],
    injectionPath: 'Read by the Discord alpha adapter for API identity checks and outbound sends.',
    redactionPolicy: 'Configured values and Bot authorization headers are redacted.',
    rotationPlan: 'Rotate in the Discord developer portal, update env/config, restart Gateway, and verify alpha send path.',
    revocationPlan: 'Regenerate/revoke in Discord and remove local env/config value.',
    failureMode: 'Discord alpha outbound sends fail or connector remains credentials_needed.',
    futureVaultScope: 'workspace/channel/discord/bot_token',
  },
  {
    id: 'discord_application_id',
    label: 'Discord application ID',
    provider: 'discord',
    class: 'provider_identifier',
    secret: false,
    exactMatchRedaction: true,
    owner: 'provider',
    env: ['DISCORD_APPLICATION_ID'],
    configKeys: ['channels.discord.applicationId'],
    currentStorageModes: ['environment', 'local_config', 'external_provider'],
    injectionPath: 'Read by Discord setup/status surfaces for app identity.',
    redactionPolicy: 'Treat as provider metadata; avoid raw IDs in public evidence unless intentionally redacted.',
    rotationPlan: 'Changes when Discord app changes; update env/config and proof evidence.',
    revocationPlan: 'Remove local value when app is deprovisioned.',
    failureMode: 'Discord app setup/status lacks provider identity context.',
    futureVaultScope: 'workspace/channel/discord/application',
  },
  {
    id: 'discord_public_key',
    label: 'Discord interaction public key',
    provider: 'discord',
    class: 'verification_key',
    secret: false,
    exactMatchRedaction: true,
    owner: 'provider',
    env: ['DISCORD_PUBLIC_KEY'],
    configKeys: ['channels.discord.publicKey'],
    currentStorageModes: ['environment', 'local_config', 'external_provider'],
    injectionPath: 'Read by the Discord alpha adapter to verify signed interactions.',
    redactionPolicy: 'Not a secret, but evidence should avoid raw provider identifiers unless needed for local proof.',
    rotationPlan: 'Update if the Discord application key changes; rerun signature verification proof.',
    revocationPlan: 'Remove the local value when Discord alpha is disabled or app is deprovisioned.',
    failureMode: 'Discord interactions cannot be verified.',
    futureVaultScope: 'workspace/channel/discord/public_key',
  },
  {
    id: 'model_provider_api_keys',
    label: 'OpenCode model provider API keys',
    provider: 'opencode',
    class: 'model_provider_key',
    secret: true,
    exactMatchRedaction: true,
    owner: 'opencode',
    env: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    configKeys: [],
    currentStorageModes: ['opencode_config', 'environment', 'not_gateway_managed'],
    injectionPath: 'Owned by OpenCode/provider tooling; Gateway records model/provider names and usage metadata, not raw keys.',
    redactionPolicy: 'Gateway evidence must not include provider API keys; provider names/model IDs are safe metadata.',
    rotationPlan: 'Rotate in the model provider/OpenCode environment, then rerun Gateway health and agent dispatch proof.',
    revocationPlan: 'Revoke at provider and remove from OpenCode/service environment.',
    failureMode: 'OpenCode sessions fail provider authentication; Gateway should surface failure without key material.',
    futureVaultScope: 'workspace/opencode/model_provider',
  },
  {
    id: 'mcp_connector_credentials',
    label: 'OpenCode MCP and connector credentials',
    provider: 'mcp',
    class: 'mcp_credential',
    secret: true,
    exactMatchRedaction: true,
    owner: 'opencode',
    env: [],
    configKeys: [],
    currentStorageModes: ['opencode_config', 'not_gateway_managed'],
    injectionPath: 'Owned by OpenCode MCP server configuration; Gateway references MCP/tool names and capability declarations only.',
    redactionPolicy: 'Gateway docs, profile/team config, and evidence must not copy MCP credential values.',
    rotationPlan: 'Rotate in the MCP server/provider, then verify OpenCode tool access and Gateway profile drift.',
    revocationPlan: 'Revoke in provider/MCP config and remove from OpenCode assets.',
    failureMode: 'OpenCode tool calls fail; Gateway should report tool/session failure without secret values.',
    futureVaultScope: 'workspace/opencode/mcp',
  },
  {
    id: 'future_worker_secret_bundle',
    label: 'Future remote worker scoped secret bundle',
    provider: 'worker',
    class: 'future_worker_secret',
    secret: true,
    exactMatchRedaction: true,
    owner: 'future_vault',
    env: [],
    configKeys: [],
    currentStorageModes: ['future_vault'],
    injectionPath: 'Not implemented; future workers must receive named secret references only after identity, lease, quota, and sandbox checks.',
    redactionPolicy: 'Future worker evidence may include secret reference IDs, never values.',
    rotationPlan: 'Rotate through vault reference versioning and worker lease renewal.',
    revocationPlan: 'Revoke the vault grant and terminate/cleanup affected workers.',
    failureMode: 'Remote execution remains disabled until scoped injection and cleanup proof exist.',
    futureVaultScope: 'worker/lease/scoped_secret_bundle',
  },
]

export function buildSecretsLifecycleReport(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env): SecretsLifecycleReport {
  const secretReferences = buildSecretReferences(config, env)
  const configuredInputs = configuredSecretInputs(config, env, secretReferences)
  const risks = secretLifecycleRisks(config, env, configuredInputs)
  const operatorPosture = buildSecretLifecycleOperatorPosture(secretReferences, risks)
  return {
    mode: 'local_operator_managed',
    releaseStatus: 'supported_public_local_beta',
    vaultStatus: 'local_reference_adapter_preview',
    hostedTeamStatus: 'unsupported_until_m25_decision',
    teamPreviewStatus: 'bounded_scoped_injection_preview',
    rawSecretPolicy: 'never_in_durable_work_or_evidence',
    scopedInjection: {
      implemented: true,
      defaultPolicy: 'deny_unknown_or_overbroad_requests',
      rawValuePolicy: 'in_memory_only',
      providerScopeEnforced: true,
      revokedReferencesDenied: true,
      staleRotationDenied: true,
      supportedContexts: ['http', 'channel', 'connector', 'mcp', 'opencode', 'subprocess', 'worker'],
    },
    totals: {
      inventoryItems: SECRET_INPUT_INVENTORY.length,
      secretInputs: SECRET_INPUT_INVENTORY.filter(input => input.secret).length,
      providerIdentifiers: SECRET_INPUT_INVENTORY.filter(input => !input.secret).length,
      environmentBackedInputs: SECRET_INPUT_INVENTORY.filter(input => input.currentStorageModes.includes('environment')).length,
      localConfigBackedInputs: SECRET_INPUT_INVENTORY.filter(input => input.currentStorageModes.includes('local_config')).length,
      opencodeOwnedInputs: SECRET_INPUT_INVENTORY.filter(input => input.owner === 'opencode').length,
      futureVaultBackedInputs: SECRET_INPUT_INVENTORY.filter(input => input.currentStorageModes.includes('future_vault')).length,
      configuredReferences: secretReferences.length,
      injectableReferences: secretReferences.filter(reference => reference.injection.valueAvailable && reference.injection.exportEnvNames.length).length,
    },
    configuredInputs,
    secretReferences,
    operatorPosture,
    auditEventTypes: [
      'secret.lifecycle.inventory',
      'secret.lifecycle.injection_allowed',
      'secret.lifecycle.injection_denied',
      'secret.lifecycle.rotation_plan_viewed',
      'secret.lifecycle.revocation_plan_viewed',
      'secret.lifecycle.reference_revoked',
    ],
    risks,
    caveats: [
      'Current public release supports local operator managed environment variables and local config values only.',
      'Bounded team-preview scoped injection guardrails are provided, but not a managed self-hosted, hosted, or multi-tenant vault.',
      'Config file secrets are supported for local beta compatibility, but environment variables remain preferred until a managed vault is selected.',
      'OpenCode model provider and MCP credentials remain owned by OpenCode/provider tooling; Gateway must not copy those values into durable work or evidence.',
      'Scoped injection is allowlist based and may pass values only in process memory to explicitly approved local contexts with matching kind, provider, project, and worker lease scope.',
    ],
  }
}

export function buildSecretLifecycleOperatorPosture(
  references: SecretReference[],
  risks: SecretLifecycleRisk[] = [],
): SecretLifecycleOperatorPosture {
  const rotationHealth: Record<SecretRotationHealth, number> = {
    healthy: 0,
    due: 0,
    overdue: 0,
    blocked: 0,
    unsupported: 0,
  }
  const revocation: Record<SecretRevocationState, number> = {
    active: 0,
    revoked: 0,
    unsupported: 0,
  }
  for (const reference of references) {
    rotationHealth[reference.rotation.health] += 1
    revocation[reference.revocation.state] += 1
  }
  const nextActions = [
    ...risks.map(risk => `${risk.severity}:${risk.code}:${risk.remediation}`),
    ...references.filter(reference => reference.rotation.health !== 'healthy').map(reference => `${reference.inputId}:${reference.rotation.health}:${reference.rotation.nextAction}`),
    ...references.filter(reference => reference.revocation.state === 'revoked').map(reference => `${reference.inputId}:revoked:${reference.revocation.plan}`),
  ]
  return {
    mode: 'local_and_team_preview_secret_lifecycle',
    redacted: true,
    rotationHealth,
    revocation,
    injectionGuardrails: {
      failClosed: true,
      exactReferences: true,
      exactEnvAllowlist: true,
      contextKindEnforced: true,
      providerScopeEnforced: true,
      projectScopeRequired: true,
      workerLeaseRequired: true,
      revokedReferencesDenied: true,
      staleRotationDenied: true,
      valuesInMemoryOnly: true,
    },
    evidencePolicy: {
      redacted: true,
      allowedFields: ['secretref_* ids', 'input ids', 'env var names', 'config key names', 'providers', 'scope paths', 'rotation health', 'revocation state', 'denial codes'],
      forbiddenFields: ['secret values', 'auth headers', 'provider payloads', 'webhook URLs', 'raw channel targets', 'private prompts', 'unredacted local paths'],
    },
    references: references.map(reference => ({
      id: reference.id,
      inputId: reference.inputId,
      label: reference.label,
      class: reference.class,
      owner: reference.owner,
      provider: reference.provider,
      source: reference.source,
      scope: reference.scope,
      capability: reference.capability,
      rotation: {
        posture: reference.rotation.posture,
        health: reference.rotation.health,
        lastVerifiedAt: reference.rotation.lastVerifiedAt,
        nextAction: reference.rotation.nextAction,
      },
      revocation: reference.revocation,
      injection: {
        destination: reference.injection.destination,
        exportEnvNames: reference.injection.exportEnvNames,
        allowedContextKinds: reference.injection.allowedContextKinds,
        valueAvailable: reference.injection.valueAvailable,
      },
      redaction: reference.redaction,
    })),
    nextActions: [...new Set(nextActions)],
  }
}

export function configuredSecretInputs(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env, references: SecretReference[] = buildSecretReferences(config, env)): ConfiguredSecretInput[] {
  const referencesByInput = referencesByInputId(references)
  return SECRET_INPUT_INVENTORY
    .map(input => {
      const envRefs = input.env.filter(name => isConfiguredEnvValue(name, env[name]))
      const configRefs = input.configKeys.filter(key => isConfiguredConfigValue(configValue(config, key)))
      const configuredVia: Array<'environment' | 'local_config'> = []
      if (envRefs.length) configuredVia.push('environment')
      if (configRefs.length) configuredVia.push('local_config')
      return configuredVia.length ? {
        id: input.id,
        class: input.class,
        secret: input.secret,
        configuredVia,
        env: envRefs,
        configKeys: configRefs,
        referenceIds: (referencesByInput.get(input.id) || []).map(reference => reference.id),
      } satisfies ConfiguredSecretInput : undefined
    })
    .filter((input): input is ConfiguredSecretInput => Boolean(input))
}

export function buildSecretReferences(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env): SecretReference[] {
  const references: SecretReference[] = []
  for (const input of SECRET_INPUT_INVENTORY) {
    for (const envName of input.env.filter(name => isConfiguredEnvValue(name, env[name]))) {
      references.push(secretReferenceFor(input, 'environment', envName, config, env))
    }
    for (const configKey of input.configKeys.filter(key => isConfiguredConfigValue(configValue(config, key)))) {
      references.push(secretReferenceFor(input, 'local_config', configKey, config, env))
    }
  }
  return references.sort((a, b) => a.id.localeCompare(b.id))
}

export class LocalSecretVaultAdapter {
  private readonly references: SecretReference[]

  constructor(private readonly config: GatewayConfig, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.references = buildSecretReferences(config, env)
  }

  listReferences(): SecretReference[] {
    return this.references.map(reference => ({
      ...reference,
      scope: { ...reference.scope },
      injection: {
        ...reference.injection,
        sourceEnvNames: [...reference.injection.sourceEnvNames],
        exportEnvNames: [...reference.injection.exportEnvNames],
        allowedContextKinds: [...reference.injection.allowedContextKinds],
      },
    }))
  }

  resolve(referenceId: SecretReferenceId): SecretVaultResolution {
    const reference = this.references.find(candidate => candidate.id === referenceId)
    if (!reference) return { ok: false, referenceId, reason: 'unknown secret reference' }
    const value = this.secretValue(reference)
    if (!value) return { ok: false, referenceId, reference, reason: 'secret reference has no locally resolvable value' }
    return { ok: true, referenceId, reference, value }
  }

  injectScopedSecrets(request: ScopedSecretInjectionRequest): ScopedSecretInjectionResult {
    const baseEnv = { ...(request.baseEnv || {}) }
    const denied: ScopedSecretInjectionDenial[] = []
    const injected: ScopedSecretInjectionResult['injected'] = []
    const resolvedValues = new Map<SecretReferenceId, string>()
    const envAllowlist = [...new Set(request.allowEnv.map(name => String(name || '').trim()).filter(Boolean))]
    const selectedRefs = request.referenceIds.map(referenceId => this.references.find(reference => reference.id === referenceId))
    const selectedEnvNames = new Set(selectedRefs.filter((reference): reference is SecretReference => Boolean(reference)).flatMap(reference => reference.injection.exportEnvNames))

    if (envAllowlist.some(isOverbroadEnvAllowlistName)) {
      denied.push({ code: 'overbroad_allowlist', reason: 'secret injection requires exact env names; wildcards are denied' })
    }
    for (const envName of envAllowlist) {
      if (!selectedEnvNames.has(envName)) denied.push({ code: 'unknown_allowlisted_env', reason: `allowlisted env export name is not attached to requested secret references: ${envName}` })
    }
    for (const referenceId of request.referenceIds) {
      const reference = this.references.find(candidate => candidate.id === referenceId)
      if (!reference) {
        denied.push({ referenceId, code: 'unknown_reference', reason: 'secret reference is not known to the local vault adapter' })
        continue
      }
      if (!reference.injection.allowedContextKinds.includes(request.context.kind)) {
        denied.push({ referenceId, code: 'context_not_allowed', reason: `secret reference is not allowed for ${request.context.kind} injection` })
        continue
      }
      if (reference.revocation.state === 'revoked') {
        denied.push({ referenceId, code: 'reference_revoked', reason: 'secret reference is revoked and cannot be injected' })
        continue
      }
      if (reference.rotation.health === 'overdue' || reference.rotation.health === 'blocked') {
        denied.push({ referenceId, code: 'rotation_stale', reason: `secret reference rotation health is ${reference.rotation.health}; rotate or unblock before injection` })
        continue
      }
      if ((request.context.kind === 'channel' || request.context.kind === 'connector') && reference.provider && reference.provider !== request.context.provider) {
        denied.push({ referenceId, code: 'provider_scope_mismatch', reason: `secret reference for ${reference.provider} cannot be injected into ${request.context.provider || 'unknown'} ${request.context.kind} context` })
        continue
      }
      if (reference.scope.projectScoped && (request.context.kind === 'channel' || request.context.kind === 'connector' || request.context.kind === 'worker') && !request.context.projectId) {
        denied.push({ referenceId, code: 'project_scope_required', reason: 'project-scoped secret references require an explicit projectId in the injection context' })
        continue
      }
      if (reference.scope.workerScoped && (!request.context.workerId || !request.context.leaseId)) {
        denied.push({ referenceId, code: 'worker_scope_required', reason: 'worker-scoped secret references require workerId and leaseId in the injection context' })
        continue
      }
      const envName = reference.injection.exportEnvNames.find(name => envAllowlist.includes(name))
      if (!envName) {
        denied.push({ referenceId, code: 'env_not_allowlisted', reason: 'secret reference env name was not explicitly allowlisted' })
        continue
      }
      const value = this.secretValue(reference)
      if (!value) {
        denied.push({ referenceId, code: 'value_unavailable', reason: 'secret reference has no locally resolvable value' })
        continue
      }
      resolvedValues.set(referenceId, value)
      injected.push({ referenceId, inputId: reference.inputId, envName, source: reference.source, scope: reference.scope })
    }

    if (denied.length) return { allowed: false, env: baseEnv, injected: [], denied }

    for (const item of injected) {
      const value = resolvedValues.get(item.referenceId)
      if (value) baseEnv[item.envName] = value
    }
    return { allowed: true, env: baseEnv, injected, denied: [] }
  }

  private secretValue(reference: SecretReference): string {
    if (reference.source === 'environment' && reference.envName) return String(this.env[reference.envName] || '').trim()
    if (reference.source === 'local_config' && reference.configKey) return String(configValue(this.config, reference.configKey) || '').trim()
    return ''
  }
}

export function createLocalSecretVaultAdapter(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env): LocalSecretVaultAdapter {
  return new LocalSecretVaultAdapter(config, env)
}

function secretLifecycleRisks(config: GatewayConfig, env: NodeJS.ProcessEnv, configured: ConfiguredSecretInput[]): SecretLifecycleRisk[] {
  const risks: SecretLifecycleRisk[] = []
  for (const input of configured) {
    if (input.secret && input.configKeys.length) {
      risks.push({
        code: 'local_config_secret_storage',
        severity: 'warning',
        inputId: input.id,
        summary: `${input.id} is stored in local config compatibility mode.`,
        remediation: 'Prefer environment variables today; use value-free references, rotation posture, and scoped injection checks before sharing team-preview workflows.',
      })
    }
  }
  const whatsappConfigured = hasAnyConfigured(config, env, ['whatsapp_access_token', 'whatsapp_verify_token'])
  const whatsappAppSecret = hasAnyConfigured(config, env, ['whatsapp_app_secret'])
  if (whatsappConfigured && !whatsappAppSecret) {
    risks.push({
      code: 'whatsapp_signature_secret_missing',
      severity: 'critical',
      inputId: 'whatsapp_app_secret',
      summary: 'WhatsApp credentials are partially configured without an app secret for signed inbound webhook verification.',
      remediation: 'Set WHATSAPP_APP_SECRET or channels.whatsapp.appSecret before accepting inbound WhatsApp messages.',
    })
  }
  return risks
}

function hasAnyConfigured(config: GatewayConfig, env: NodeJS.ProcessEnv, ids: string[]): boolean {
  return ids.some(id => {
    const input = SECRET_INPUT_INVENTORY.find(entry => entry.id === id)
    if (!input) return false
    return input.env.some(name => isConfiguredEnvValue(name, env[name]))
      || input.configKeys.some(key => isConfiguredConfigValue(configValue(config, key)))
  })
}

function referencesByInputId(references: SecretReference[]): Map<string, SecretReference[]> {
  const byInput = new Map<string, SecretReference[]>()
  for (const reference of references) {
    const list = byInput.get(reference.inputId) || []
    list.push(reference)
    byInput.set(reference.inputId, list)
  }
  return byInput
}

function secretReferenceFor(input: SecretInputDefinition, source: SecretReferenceSource, location: string, config: GatewayConfig, env: NodeJS.ProcessEnv): SecretReference {
  const envName = source === 'environment' ? location : undefined
  const configKey = source === 'local_config' ? location : undefined
  const sourceEnvNames = envName ? [envName] : []
  const exportEnvNames = envName ? [envName] : input.env.slice()
  const id = secretReferenceId(input, source, location)
  const lifecycle = secretLifecycleConfig(config)
  const rotationHealth = secretRotationHealth(input, source, id, config, env, lifecycle)
  const revokedAt = lifecycle.revokedAtByReferenceId?.[id] || lifecycle.revokedAtByInputId?.[input.id]
  const revoked = (lifecycle.revokedReferenceIds || []).includes(id) || (lifecycle.revokedInputIds || []).includes(input.id)
  return {
    id,
    inputId: input.id,
    label: input.label,
    class: input.class,
    secret: input.secret,
    owner: input.owner,
    provider: input.provider,
    source,
    storageMode: source,
    location,
    envName,
    configKey,
    scope: secretReferenceScope(input),
    injection: {
      destination: injectionDestination(input),
      sourceEnvNames,
      exportEnvNames,
      allowedContextKinds: allowedInjectionContexts(input),
      valueAvailable: true,
    },
    lastSeen: {
      configured: true,
      source,
      location,
    },
    rotation: {
      posture: rotationPosture(input),
      health: rotationHealth,
      lastVerifiedAt: lifecycle.lastVerifiedAtByReferenceId?.[id] || lifecycle.lastVerifiedAtByInputId?.[input.id],
      nextAction: rotationNextAction(input, rotationHealth),
      rotationPlan: input.rotationPlan,
      revocationPlan: input.revocationPlan,
    },
    revocation: {
      state: revoked ? 'revoked' : input.owner === 'future_vault' ? 'unsupported' : 'active',
      revokedAt,
      reason: revoked ? 'Reference or input is marked revoked in value-free secret lifecycle config.' : undefined,
      plan: input.revocationPlan,
    },
    redaction: {
      valueExposed: false,
      exactMatch: input.exactMatchRedaction,
      safeLabel: input.id,
      policy: input.redactionPolicy,
    },
    capability: secretCapability(input),
    audit: {
      redacted: true,
      eventTypes: ['secret.lifecycle.inventory', 'secret.lifecycle.injection_denied', 'secret.lifecycle.injection_allowed', 'secret.lifecycle.rotation_plan_viewed', 'secret.lifecycle.revocation_plan_viewed'],
    },
  }
}

function secretReferenceId(input: SecretInputDefinition, source: SecretReferenceSource, location: string): SecretReferenceId {
  const hash = createHash('sha256').update(`${input.id}:${source}:${location}`).digest('hex').slice(0, 16)
  return `secretref_${slug(input.id)}_${hash}`
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'secret'
}

function secretReferenceScope(input: SecretInputDefinition): SecretReferenceScope {
  const path = input.futureVaultScope
  const kind: SecretScopeKind = path.startsWith('system/')
    ? 'system'
    : path.startsWith('worker/')
      ? 'worker'
      : path.includes('/mcp')
        ? 'mcp'
        : path.includes('/channel/')
          ? 'channel'
          : path.includes('/connector/')
            ? 'connector'
            : path.startsWith('project/')
              ? 'project'
              : path.startsWith('workspace/')
                ? 'workspace'
                : 'provider'
  return {
    kind,
    path,
    provider: input.provider,
    projectScoped: path.startsWith('project/'),
    workerScoped: path.startsWith('worker/'),
  }
}

function allowedInjectionContexts(input: SecretInputDefinition): SecretInjectionContextKind[] {
  if (input.provider === 'gateway_http') return ['http']
  if (input.provider === 'telegram' || input.provider === 'whatsapp' || input.provider === 'discord') return ['channel', 'connector', 'subprocess']
  if (input.provider === 'opencode') return ['opencode', 'subprocess']
  if (input.provider === 'mcp') return ['mcp', 'subprocess']
  if (input.provider === 'worker') return ['worker']
  return ['subprocess']
}

function injectionDestination(input: SecretInputDefinition): string {
  if (input.provider === 'gateway_http') return 'http_security_middleware'
  if (input.provider === 'telegram' || input.provider === 'whatsapp' || input.provider === 'discord') return `${input.provider}_adapter`
  if (input.provider === 'opencode') return 'opencode_owned_runtime'
  if (input.provider === 'mcp') return 'opencode_mcp_runtime'
  if (input.provider === 'worker') return 'future_worker_envelope'
  return 'local_subprocess'
}

function rotationPosture(input: SecretInputDefinition): SecretRotationPosture {
  if (input.owner === 'local_operator') return 'operator_managed'
  if (input.owner === 'provider') return 'provider_managed'
  if (input.owner === 'opencode') return 'opencode_managed'
  return 'future_vault_required'
}

function secretRotationHealth(
  input: SecretInputDefinition,
  source: SecretReferenceSource,
  referenceId: SecretReferenceId,
  config: GatewayConfig,
  env: NodeJS.ProcessEnv,
  lifecycle: NormalizedSecretLifecycleConfig,
): SecretRotationHealth {
  const referenceOverride = normalizeRotationHealth(lifecycle.rotationHealthByReferenceId[referenceId])
  if (referenceOverride) return referenceOverride
  const inputOverride = normalizeRotationHealth(lifecycle.rotationHealthByInputId[input.id])
  if (inputOverride) return inputOverride
  if (input.owner === 'future_vault') return 'unsupported'
  if ((input.id === 'whatsapp_access_token' || input.id === 'whatsapp_verify_token') && !hasAnyConfigured(config, env, ['whatsapp_app_secret'])) return 'blocked'
  if (input.secret && source === 'local_config') return 'due'
  return 'healthy'
}

function normalizeRotationHealth(value: unknown): SecretRotationHealth | undefined {
  return value === 'healthy' || value === 'due' || value === 'overdue' || value === 'blocked' || value === 'unsupported' ? value : undefined
}

function rotationNextAction(input: SecretInputDefinition, health: SecretRotationHealth): string {
  if (health === 'healthy') return 'No immediate operator action required; keep the normal rotation plan.'
  if (health === 'due') return input.rotationPlan
  if (health === 'overdue') return `Rotate now: ${input.rotationPlan}`
  if (health === 'blocked') return input.failureMode
  return 'Unsupported until a managed vault or provider-owned lifecycle is implemented.'
}

function secretCapability(input: SecretInputDefinition): string {
  if (input.provider === 'gateway_http') return `http:${input.futureVaultScope.split('/').pop() || 'token'}`
  if (input.provider === 'telegram' || input.provider === 'whatsapp' || input.provider === 'discord') return `channel:${input.provider}`
  if (input.provider === 'opencode') return 'opencode:model_provider'
  if (input.provider === 'mcp') return 'opencode:mcp_connector'
  if (input.provider === 'worker') return 'worker:scoped_secret_bundle'
  return input.class
}

interface NormalizedSecretLifecycleConfig {
  rotationHealthByInputId: Record<string, string>
  rotationHealthByReferenceId: Record<string, string>
  lastVerifiedAtByInputId: Record<string, string>
  lastVerifiedAtByReferenceId: Record<string, string>
  revokedInputIds: string[]
  revokedReferenceIds: SecretReferenceId[]
  revokedAtByInputId: Record<string, string>
  revokedAtByReferenceId: Record<string, string>
}

function secretLifecycleConfig(config: GatewayConfig | undefined): NormalizedSecretLifecycleConfig {
  const lifecycle = (config as any)?.secretLifecycle || {}
  return {
    rotationHealthByInputId: objectRecord(lifecycle.rotationHealthByInputId),
    rotationHealthByReferenceId: objectRecord(lifecycle.rotationHealthByReferenceId),
    lastVerifiedAtByInputId: objectRecord(lifecycle.lastVerifiedAtByInputId),
    lastVerifiedAtByReferenceId: objectRecord(lifecycle.lastVerifiedAtByReferenceId),
    revokedInputIds: stringArray(lifecycle.revokedInputIds),
    revokedReferenceIds: stringArray(lifecycle.revokedReferenceIds) as SecretReferenceId[],
    revokedAtByInputId: objectRecord(lifecycle.revokedAtByInputId),
    revokedAtByReferenceId: objectRecord(lifecycle.revokedAtByReferenceId),
  }
}

function objectRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, String(child || '').trim()])
      .filter(([, child]) => Boolean(child)),
  )
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : []
}

export function formatSecretsLifecycleReport(report: SecretsLifecycleReport): string {
  const posture = report.operatorPosture
  const lines = [
    'Secret Lifecycle',
    `Mode: ${report.mode}`,
    `Release status: ${report.releaseStatus}`,
    `Vault status: ${report.vaultStatus}`,
    `Team preview: ${report.teamPreviewStatus}`,
    `Raw secret policy: ${report.rawSecretPolicy}`,
    `References: ${report.totals.configuredReferences} configured | ${report.totals.injectableReferences} injectable | ${report.totals.secretInputs} secret inputs inventoried`,
    `Rotation health: healthy ${posture.rotationHealth.healthy}, due ${posture.rotationHealth.due}, overdue ${posture.rotationHealth.overdue}, blocked ${posture.rotationHealth.blocked}, unsupported ${posture.rotationHealth.unsupported}`,
    `Revocation: active ${posture.revocation.active}, revoked ${posture.revocation.revoked}, unsupported ${posture.revocation.unsupported}`,
    `Guardrails: exact refs ${yes(posture.injectionGuardrails.exactReferences)}, exact env ${yes(posture.injectionGuardrails.exactEnvAllowlist)}, provider scope ${yes(posture.injectionGuardrails.providerScopeEnforced)}, project scope ${yes(posture.injectionGuardrails.projectScopeRequired)}, worker lease ${yes(posture.injectionGuardrails.workerLeaseRequired)}, values ${report.scopedInjection.rawValuePolicy}`,
    '',
    'Configured references:',
    ...(posture.references.length
      ? posture.references.map(reference => `- ${reference.id} ${reference.inputId} ${reference.source} ${reference.scope.path} capability=${reference.capability} rotation=${reference.rotation.health} revocation=${reference.revocation.state} destination=${reference.injection.destination}`)
      : ['- none configured']),
    '',
    'Risks:',
    ...(report.risks.length ? report.risks.map(risk => `- [${risk.severity}] ${risk.code} ${risk.inputId}: ${risk.remediation}`) : ['- none']),
    '',
    'Safe next actions:',
    ...(posture.nextActions.length ? posture.nextActions.map(action => `- ${action}`) : ['- No immediate secret lifecycle actions.']),
    '',
    'Evidence policy:',
    `- allowed: ${posture.evidencePolicy.allowedFields.join(', ')}`,
    `- forbidden: ${posture.evidencePolicy.forbiddenFields.join(', ')}`,
  ]
  return lines.join('\n')
}

function yes(value: boolean): string {
  return value ? 'on' : 'off'
}

export function readScopedHttpTokenFile(filePath: string | undefined): string | undefined {
  const target = String(filePath || '').trim()
  if (!target) return undefined
  let descriptor: number | undefined
  try {
    const before = fs.lstatSync(target)
    if (!isSafeScopedHttpTokenFile(before)) return undefined
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
    const opened = fs.fstatSync(descriptor)
    if (!isSafeScopedHttpTokenFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino) return undefined
    const buffer = Buffer.allocUnsafe(MAX_SCOPED_HTTP_TOKEN_FILE_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (count === 0) break
      bytesRead += count
    }
    if (bytesRead > MAX_SCOPED_HTTP_TOKEN_FILE_BYTES) return undefined
    const value = buffer.subarray(0, bytesRead).toString('utf8').trim()
    if (!value || /[\0\r\n]/.test(value)) return undefined
    return value
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
  }
}

function isSafeScopedHttpTokenFile(stat: fs.Stats): boolean {
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SCOPED_HTTP_TOKEN_FILE_BYTES) return false
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return false
  return true
}

export function configuredRedactionValues(config: GatewayConfig | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = []
  for (const input of SECRET_INPUT_INVENTORY) {
    if (!shouldExactMatchRedact(input)) continue
    for (const envName of input.env) {
      if (isConfiguredEnvValue(envName, env[envName])) values.push(String(env[envName] || '').trim())
      if (input.provider === 'gateway_http' && input.class === 'http_bearer_token') {
        const tokenFileValue = readScopedHttpTokenFile(env[`${envName}_FILE`])
        if (tokenFileValue) values.push(tokenFileValue)
      }
    }
    for (const key of input.configKeys) {
      const value = configValue(config, key)
      if (isConfiguredConfigValue(value)) values.push(String(value).trim())
    }
  }
  return [...new Set(values.filter(value => value.length >= 4))]
}


function shouldExactMatchRedact(input: SecretInputDefinition): boolean {
  return input.exactMatchRedaction
}

function isOverbroadEnvAllowlistName(name: string): boolean {
  return name === '*' || name.endsWith('*')
}

function isConfiguredEnvValue(name: string, value: string | undefined): boolean {
  const text = String(value || '').trim()
  if (!text) return false
  if (name === 'OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED') return ['1', 'true', 'yes', 'on'].includes(text.toLowerCase())
  return true
}

function isConfiguredConfigValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return Boolean(value.trim())
  return value !== undefined && value !== null
}

function configValue(config: GatewayConfig | undefined, key: string): unknown {
  return key.split('.').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[segment]
  }, config)
}
