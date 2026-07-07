import type {
  ManagedDesktopPolicyView,
  ManagedPolicyExtensionClasses,
} from '@open-cowork/shared'
import type { ControlPlaneStore, ManagedPolicyRecord } from '../control-plane-store.ts'
import { toManagedDesktopPolicyView } from '../control-plane-store.ts'
import type { ControlPlanePermission } from '../control-plane-permissions.ts'
import type { AuditActorInput } from '../control-plane-account-inputs.ts'
import type { CloudPrincipal } from '../session-service-types.ts'

// Managed workspace & desktop policy service (#898): the org-scoped surface an admin
// uses to read and set the policy that clamps the desktop's permission maxima, scopes
// providers/models, gates extension classes, and pins the update channel. Editing is
// gated on the fine-grained `policy:manage` permission; the effective-policy read used
// by the desktop delivery path (GET /api/config) is available to any authenticated
// member, so every seat enforces its org's policy. An org with no policy set — and any
// individual with no org — resolves to the unrestricted defaults, so nothing changes
// for them. Every mutation is audited via the store (managed_policy.updated).

export type CloudPolicyServiceOptions = {
  store: ControlPlaneStore
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  assertPermission: (principal: CloudPrincipal, permission: ControlPlanePermission) => void
  principalOrgId: (principal: CloudPrincipal) => string
  auditActor: (principal: CloudPrincipal) => AuditActorInput
}

export type SetManagedPolicyRequest = {
  allowedProviders?: readonly string[] | null
  deniedProviders?: readonly string[]
  allowedModels?: readonly string[] | null
  deniedModels?: readonly string[]
  keyManagement?: string | null
  extensions?: Partial<ManagedPolicyExtensionClasses> | null
  features?: Record<string, unknown> | null
  permissionCeilings?: Partial<Record<string, unknown>> | null
  updateChannel?: string | null
}

export class CloudPolicyService {
  private readonly store: ControlPlaneStore
  private readonly ensurePrincipal: CloudPolicyServiceOptions['ensurePrincipal']
  private readonly assertPermission: CloudPolicyServiceOptions['assertPermission']
  private readonly principalOrgId: CloudPolicyServiceOptions['principalOrgId']
  private readonly auditActor: CloudPolicyServiceOptions['auditActor']

  constructor(options: CloudPolicyServiceOptions) {
    this.store = options.store
    this.ensurePrincipal = options.ensurePrincipal
    this.assertPermission = options.assertPermission
    this.principalOrgId = options.principalOrgId
    this.auditActor = options.auditActor
  }

  // Admin read: the stored record (or null when unset). Gated on policy:manage so the
  // admin surface only exposes the editable policy to those who can change it.
  async getManagedPolicy(principal: CloudPrincipal): Promise<ManagedPolicyRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'policy:manage')
    return this.store.getManagedPolicy(this.principalOrgId(principal))
  }

  // Admin write: merge a partial input onto the current policy and persist. Returns the
  // full effective record. Audited by the store.
  async setManagedPolicy(principal: CloudPrincipal, input: SetManagedPolicyRequest): Promise<ManagedPolicyRecord> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'policy:manage')
    return this.store.setManagedPolicy({
      orgId: this.principalOrgId(principal),
      ...input,
      actor: this.auditActor(principal),
    })
  }

  // The effective policy delivered to the desktop for enforcement. Available to any
  // authenticated member; falls back to the unrestricted defaults when no policy is set
  // (or the principal has no org), and carries the machine-readable disabledByPolicy map.
  async getEffectiveManagedPolicy(principal: CloudPrincipal): Promise<ManagedDesktopPolicyView> {
    await this.ensurePrincipal(principal)
    const record = await this.store.getManagedPolicy(this.principalOrgId(principal))
    return toManagedDesktopPolicyView(record)
  }
}
