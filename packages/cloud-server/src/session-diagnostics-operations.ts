// Operator diagnostics bundle, carved out of the CloudSessionService god class
// (ARCH god-class, P2). getDiagnosticsBundle fans out across billing, usage, BYOK,
// worker heartbeats, and the channel gateway to assemble a redacted snapshot — real
// body logic, moved verbatim so behavior is byte-identical. CloudSessionService now
// keeps a thin delegating getDiagnosticsBundle. The two cross-service reads it needs
// (the billing subscription summary and the usage summary) are passed as callbacks so
// this module stays a coordinator over the store + sub-services rather than reaching
// back into the session service.
import type { ControlPlaneStore } from './control-plane-store.ts'
import { CloudServiceError } from './cloud-service-error.ts'
import { type CloudRuntimePolicy } from './cloud-config.ts'
import type { CloudByokService } from './services/byok-service.ts'
import { principalCanViewDiagnostics } from './session-principal-access.ts'
import type { CloudBillingOperationsService } from './session-billing-operations.ts'
import type { CloudDiagnosticsBundle, CloudPrincipal, CloudUsageSummary } from './session-service.ts'

export type CloudDiagnosticsOperationsServiceOptions = {
  store: ControlPlaneStore
  policy: CloudRuntimePolicy
  byokService: CloudByokService
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  principalOrgId: (principal: CloudPrincipal) => string
  getBillingSubscription: (
    principal: CloudPrincipal,
  ) => ReturnType<CloudBillingOperationsService['getBillingSubscription']>
  getUsageSummary: (principal: CloudPrincipal, limit?: number) => Promise<CloudUsageSummary>
}

export class CloudDiagnosticsOperationsService {
  private readonly store: ControlPlaneStore
  private readonly policy: CloudRuntimePolicy
  private readonly byokService: CloudByokService
  private readonly ensurePrincipal: CloudDiagnosticsOperationsServiceOptions['ensurePrincipal']
  private readonly principalOrgId: CloudDiagnosticsOperationsServiceOptions['principalOrgId']
  private readonly getBillingSubscription: CloudDiagnosticsOperationsServiceOptions['getBillingSubscription']
  private readonly getUsageSummary: CloudDiagnosticsOperationsServiceOptions['getUsageSummary']

  constructor(options: CloudDiagnosticsOperationsServiceOptions) {
    this.store = options.store
    this.policy = options.policy
    this.byokService = options.byokService
    this.ensurePrincipal = options.ensurePrincipal
    this.principalOrgId = options.principalOrgId
    this.getBillingSubscription = options.getBillingSubscription
    this.getUsageSummary = options.getUsageSummary
  }

  async getDiagnosticsBundle(principal: CloudPrincipal): Promise<CloudDiagnosticsBundle> {
    await this.ensurePrincipal(principal)
    if (!principalCanViewDiagnostics(principal)) {
      throw new CloudServiceError(403, 'Cloud diagnostics require operator privileges.')
    }
    const orgId = this.principalOrgId(principal)
    const deliverySampleLimit = 200
    const [billing, usage, byok, heartbeats, agents, deliveries] = await Promise.all([
      this.getBillingSubscription(principal),
      this.getUsageSummary(principal, 200),
      this.byokService.listSecretMetadataForOrg(orgId),
      this.store.listWorkerHeartbeats(),
      this.store.listHeadlessAgents(orgId),
      this.store.listChannelDeliveries({ orgId, limit: deliverySampleLimit }),
    ])
    const bindings = (await Promise.all(agents.map((agent) => this.store.listChannelBindings(orgId, agent.agentId)))).flat()
    const deliveryCounts: Record<string, number> = {
      pending: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      dead: 0,
    }
    for (const delivery of deliveries) {
      deliveryCounts[delivery.status] = (deliveryCounts[delivery.status] || 0) + 1
    }
    const bindingsByProvider: Record<string, number> = {}
    for (const binding of bindings) {
      bindingsByProvider[binding.provider] = (bindingsByProvider[binding.provider] || 0) + 1
    }
    const now = Date.now()
    const runtimeHeartbeats = heartbeats.map((heartbeat) => {
      const ageMs = Math.max(0, now - Date.parse(heartbeat.lastSeenAt))
      return {
        workerId: heartbeat.workerId,
        role: heartbeat.role,
        activeSessionCount: heartbeat.activeSessionIds.length,
        lastSeenAt: heartbeat.lastSeenAt,
        ageMs,
        stale: ageMs > 60_000,
      }
    })
    return {
      generatedAt: new Date().toISOString(),
      redaction: 'secrets-redacted',
      org: {
        orgId,
        tenantId: principal.tenantId,
        role: principal.role || principal.authSource || 'unknown',
        profileName: this.policy.profileName,
      },
      runtime: {
        role: this.policy.role,
        profileName: this.policy.profileName,
        canExecute: this.policy.role === 'all-in-one' || this.policy.role === 'worker',
        commandProcessing: this.policy.role === 'all-in-one' ? 'inline' : this.policy.role === 'worker' ? 'durable' : 'delegated',
        checkpoints: this.policy.role === 'all-in-one' || this.policy.role === 'worker',
        heartbeatCount: heartbeats.length,
        heartbeats: runtimeHeartbeats,
      },
      billing,
      byok: {
        configuredProviders: byok.length,
        providers: byok,
      },
      usage,
      gateway: {
        agents: {
          total: agents.length,
          active: agents.filter((agent) => agent.status === 'active').length,
          disabled: agents.filter((agent) => agent.status === 'disabled').length,
        },
        bindingsByProvider,
        deliveriesByStatus: deliveryCounts,
        deliveriesByStatusScope: 'recent_deliveries',
        deliverySampleLimit,
      },
      links: {
        deploymentDocs: '/docs/open-cowork-cloud',
        managedByokRunbook: '/runbooks/managed-byok-saas',
      },
    }
  }
}
