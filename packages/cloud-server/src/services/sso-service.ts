import { randomBytes } from 'node:crypto'
import type { ControlPlaneStore } from '../control-plane-store.ts'
import {
  toPublicOrgSsoConfig,
  type PublicOrgSsoConfig,
  type SsoProtocol,
  type UpsertOrgSsoConfigInput,
} from '../control-plane-sso.ts'
import { hashScimToken } from '../control-plane-tokens.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import type { SecretAdapter } from '../secret-adapter.ts'
import type { AuditActorInput } from '../control-plane-account-inputs.ts'
import type { ControlPlanePermission } from '../control-plane-permissions.ts'
import type { CloudPrincipal } from '../session-service-types.ts'
import {
  mapAssertionToIdentity,
  ssoIdentityToPrincipal,
  SsoVerificationError,
  type SsoAssertionVerifier,
} from '../sso-assertion.ts'

// Enterprise SSO configuration + login binding service (issue #895). Owns the org SSO
// config CRUD (gated on the new sso:manage permission), the sealing of IdP secrets with
// the existing versioned envelope encryption before they touch the store, the SCIM
// bearer-token lifecycle, the SSO login binding (verified assertion → principal via
// principal-service), and SSO-only enforcement for non-SSO logins on verified domains.

export type CloudSsoServiceOptions = {
  store: ControlPlaneStore
  secretAdapter: SecretAdapter | null
  verifiers: Record<SsoProtocol, SsoAssertionVerifier>
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  assertPermission: (principal: CloudPrincipal, permission: ControlPlanePermission) => void
  principalOrgId: (principal: CloudPrincipal) => string
  auditActor: (principal: CloudPrincipal) => AuditActorInput
}

export type UpsertSsoConfigRequest = {
  protocol?: SsoProtocol
  enabled?: boolean | null
  enforced?: boolean | null
  displayName?: string | null
  verifiedDomains?: readonly string[] | null
  oidcIssuer?: string | null
  oidcClientId?: string | null
  oidcClientSecret?: string | null
  samlEntityId?: string | null
  samlAcsUrl?: string | null
  samlSloUrl?: string | null
  samlIdpEntityId?: string | null
  samlIdpSsoUrl?: string | null
  samlIdpMetadataUrl?: string | null
  samlIdpCertificate?: string | null
  scimEnabled?: boolean | null
}

function ssoAad(orgId: string, field: string) {
  return `sso:${orgId}:${field}`
}

export class CloudSsoService {
  private readonly store: ControlPlaneStore
  private readonly secretAdapter: SecretAdapter | null
  private readonly verifiers: Record<SsoProtocol, SsoAssertionVerifier>
  private readonly ensurePrincipal: CloudSsoServiceOptions['ensurePrincipal']
  private readonly assertPermission: CloudSsoServiceOptions['assertPermission']
  private readonly principalOrgId: CloudSsoServiceOptions['principalOrgId']
  private readonly auditActor: CloudSsoServiceOptions['auditActor']

  constructor(options: CloudSsoServiceOptions) {
    this.store = options.store
    this.secretAdapter = options.secretAdapter
    this.verifiers = options.verifiers
    this.ensurePrincipal = options.ensurePrincipal
    this.assertPermission = options.assertPermission
    this.principalOrgId = options.principalOrgId
    this.auditActor = options.auditActor
  }

  // Seal a plaintext IdP secret with the versioned envelope encryption, refusing to
  // persist it if the adapter cannot encrypt (never store an enterprise secret raw).
  private seal(orgId: string, field: string, plaintext: string): string {
    if (!this.secretAdapter || this.secretAdapter.mode !== 'envelope-v1') {
      throw new CloudServiceError(503, 'Storing SSO secrets requires envelope encryption (set OPEN_COWORK_CLOUD_SECRET_KEY).')
    }
    return this.secretAdapter.protect(plaintext, ssoAad(orgId, field))
  }

  async getSsoConfig(principal: CloudPrincipal): Promise<PublicOrgSsoConfig | null> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'sso:manage')
    const record = await this.store.getOrgSsoConfig(this.principalOrgId(principal))
    return record ? toPublicOrgSsoConfig(record) : null
  }

  async upsertSsoConfig(principal: CloudPrincipal, input: UpsertSsoConfigRequest): Promise<PublicOrgSsoConfig> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'sso:manage')
    const orgId = this.principalOrgId(principal)
    const patch: UpsertOrgSsoConfigInput = {
      orgId,
      protocol: input.protocol,
      enabled: input.enabled ?? undefined,
      enforced: input.enforced ?? undefined,
      displayName: input.displayName,
      verifiedDomains: input.verifiedDomains ?? undefined,
      oidcIssuer: input.oidcIssuer,
      oidcClientId: input.oidcClientId,
      oidcClientSecretCiphertext: input.oidcClientSecret === undefined
        ? undefined
        : input.oidcClientSecret === null || input.oidcClientSecret === ''
          ? null
          : this.seal(orgId, 'oidc_client_secret', input.oidcClientSecret),
      samlEntityId: input.samlEntityId,
      samlAcsUrl: input.samlAcsUrl,
      samlSloUrl: input.samlSloUrl,
      samlIdpEntityId: input.samlIdpEntityId,
      samlIdpSsoUrl: input.samlIdpSsoUrl,
      samlIdpMetadataUrl: input.samlIdpMetadataUrl,
      samlIdpCertificateCiphertext: input.samlIdpCertificate === undefined
        ? undefined
        : input.samlIdpCertificate === null || input.samlIdpCertificate === ''
          ? null
          : this.seal(orgId, 'saml_idp_certificate', input.samlIdpCertificate),
      scimEnabled: input.scimEnabled ?? undefined,
      actor: this.auditActor(principal),
    }
    const record = await this.store.upsertOrgSsoConfig(patch)
    return toPublicOrgSsoConfig(record)
  }

  async deleteSsoConfig(principal: CloudPrincipal): Promise<boolean> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'sso:manage')
    return this.store.deleteOrgSsoConfig(this.principalOrgId(principal))
  }

  // Issue (or rotate) the org's SCIM bearer token. The plaintext is returned ONCE for
  // the operator to paste into their IdP; only its salted hash is persisted. Enables
  // SCIM provisioning for the org as a side effect.
  async rotateScimToken(principal: CloudPrincipal): Promise<{ config: PublicOrgSsoConfig, scimToken: string }> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'sso:manage')
    const orgId = this.principalOrgId(principal)
    if (!(await this.store.getOrgSsoConfig(orgId))) {
      throw new CloudServiceError(404, 'Configure SSO before issuing a SCIM token.')
    }
    const scimToken = `scim_${randomBytes(32).toString('base64url')}`
    const record = await this.store.upsertOrgSsoConfig({
      orgId,
      scimEnabled: true,
      scimTokenHash: hashScimToken(scimToken),
      actor: this.auditActor(principal),
    })
    return { config: toPublicOrgSsoConfig(record), scimToken }
  }

  // The SSO login binding: verify a raw IdP assertion, map it to an org identity, and
  // bootstrap the principal through principal-service (which resolves membership →
  // effective permissions). The returned principal is SSO-verified.
  async authenticateSso(input: { orgId: string, rawAssertion: string }): Promise<CloudPrincipal> {
    const config = await this.store.getOrgSsoConfig(input.orgId)
    if (!config || !config.enabled) throw new CloudServiceError(404, 'SSO is not configured for this organization.')
    const verifier = this.verifiers[config.protocol]
    let principal: CloudPrincipal
    try {
      const assertion = await verifier.verify({ rawAssertion: input.rawAssertion, config })
      const identity = mapAssertionToIdentity(config, assertion)
      principal = ssoIdentityToPrincipal(identity, config.displayName || config.orgId)
    } catch (error) {
      if (error instanceof SsoVerificationError) throw new CloudServiceError(401, error.message)
      throw error
    }
    await this.ensurePrincipal(principal)
    return principal
  }

  // SSO-only enforcement: reject a NON-SSO (OIDC-end-user) login whose email domain is
  // verified for an org that has enforced SSO. Local (self-host) principals and already
  // SSO-verified principals are exempt so the existing fallback login keeps working for
  // deployments without enterprise SSO.
  async assertNonSsoLoginAllowed(principal: CloudPrincipal): Promise<void> {
    if (principal.authSource === 'local' || principal.ssoVerified) return
    if (principal.authSource !== 'user') return
    const domain = principal.email.slice(principal.email.lastIndexOf('@') + 1).toLowerCase()
    if (!domain) return
    const config = await this.store.findOrgSsoConfigByDomain(domain)
    if (config?.enforced) {
      throw new CloudServiceError(403, 'This organization requires SSO login. Sign in through your identity provider.')
    }
  }
}
