import { createHash } from 'node:crypto'
import { emailDomain, type OrgSsoConfigRecord, type SsoProtocol } from './control-plane-sso.ts'
import type { CloudPrincipal } from './session-service-types.ts'

// The SSO login binding (issue #895): the pluggable verifier seam plus the pure mapping
// from a verified IdP assertion to a cloud principal. The verifier is the ONLY place a
// live IdP signature is checked, so it is an injectable interface: OIDC ships a default
// backed by the existing verified-JWT path (oidc-auth.ts); SAML ships a documented,
// fail-closed default seam an operator replaces with a real SAML response validator
// wired to their IdP's signing certificate. Everything downstream of `verify` — domain
// gating, subject→account mapping, principal construction — is pure and fully tested,
// so the enterprise identity flow is exercised end-to-end without a live IdP.

export type SsoAssertion = {
  protocol: SsoProtocol
  // The IdP's stable subject identifier (OIDC `sub` / SAML NameID). Namespaced with the
  // issuer + org when we derive the account's idpSubject so two IdPs can't collide.
  subject: string
  email: string
  displayName?: string | null
  issuer?: string | null
  attributes?: Record<string, unknown>
}

export type SsoVerifierInput = {
  // The raw IdP artifact: a base64 SAML response for SAML, or the compact id_token
  // (or the already-verified claims JSON) for OIDC. The verifier owns parsing it.
  rawAssertion: string
  config: OrgSsoConfigRecord
}

// The pluggable seam. `protocol` lets the login binding pick the right verifier for an
// org's configured protocol; `verify` returns a verified assertion or throws.
export interface SsoAssertionVerifier {
  readonly protocol: SsoProtocol
  verify(input: SsoVerifierInput): Promise<SsoAssertion> | SsoAssertion
}

export class SsoVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsoVerificationError'
  }
}

// The DEFAULT SAML verifier seam. A live SAML integration must validate the IdP's
// XML-DSIG signature against the operator-provided certificate, which cannot be
// exercised in-repo without operator certs — so the default fails closed with a clear
// message. An operator supplies a real verifier (e.g. backed by a SAML library or an
// XML-DSIG check keyed on `config.samlIdpCertificateCiphertext` decrypted at boot).
export function createUnconfiguredSamlVerifier(): SsoAssertionVerifier {
  return {
    protocol: 'saml',
    verify() {
      throw new SsoVerificationError(
        'SAML assertion verification is not configured. Supply an SsoAssertionVerifier '
        + 'for the "saml" protocol wired to your IdP signing certificate.',
      )
    },
  }
}

// The default OIDC verifier: it accepts an ALREADY-verified claims object (produced by
// the existing oidc-auth verified-JWT path) as JSON. This keeps the single source of
// signature/issuer/audience truth in oidc-auth.ts and lets the login binding turn those
// verified claims into an assertion. Callers that have a raw id_token verify it with
// createOidcVerifier first, then hand the claims here.
export function createClaimsOidcVerifier(): SsoAssertionVerifier {
  return {
    protocol: 'oidc',
    verify({ rawAssertion, config }) {
      let claims: Record<string, unknown>
      try {
        claims = JSON.parse(rawAssertion) as Record<string, unknown>
      } catch {
        throw new SsoVerificationError('OIDC assertion claims are not valid JSON.')
      }
      const subject = typeof claims.sub === 'string' ? claims.sub.trim() : ''
      const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
      if (!subject) throw new SsoVerificationError('OIDC assertion is missing a subject.')
      if (!email) throw new SsoVerificationError('OIDC assertion is missing an email.')
      const issuer = typeof claims.iss === 'string' ? claims.iss : config.oidcIssuer
      return {
        protocol: 'oidc',
        subject,
        email,
        displayName: typeof claims.name === 'string' ? claims.name : null,
        issuer,
        attributes: claims,
      }
    },
  }
}

// A verifier registry so the login binding can resolve the right verifier per protocol.
export function createSsoVerifierRegistry(
  overrides: Partial<Record<SsoProtocol, SsoAssertionVerifier>> = {},
): Record<SsoProtocol, SsoAssertionVerifier> {
  return {
    oidc: overrides.oidc || createClaimsOidcVerifier(),
    saml: overrides.saml || createUnconfiguredSamlVerifier(),
  }
}

// A stable, non-reversible account subject derived from the IdP issuer + subject, so the
// same IdP identity always maps to the same account and two IdPs cannot collide. Mirrors
// oidc-auth.ts's stableUserId.
export function ssoStableSubject(issuer: string | null | undefined, subject: string): string {
  return createHash('sha256').update(`${(issuer || '').trim()}\0${subject}`).digest('hex').slice(0, 32)
}

export type SsoMappedIdentity = {
  orgId: string
  idpSubject: string
  email: string
  displayName: string | null
}

// PURE: map a verified assertion to an org identity, enforcing that (a) the assertion's
// protocol matches the org's configured protocol, (b) the org SSO config is enabled, and
// (c) the email's domain is one the org has verified. Throws on any violation.
export function mapAssertionToIdentity(config: OrgSsoConfigRecord, assertion: SsoAssertion): SsoMappedIdentity {
  if (!config.enabled) throw new SsoVerificationError('SSO is not enabled for this organization.')
  if (assertion.protocol !== config.protocol) {
    throw new SsoVerificationError(`SSO assertion protocol "${assertion.protocol}" does not match the configured "${config.protocol}".`)
  }
  const domain = emailDomain(assertion.email)
  if (!domain) throw new SsoVerificationError('SSO assertion email is malformed.')
  if (config.verifiedDomains.length > 0 && !config.verifiedDomains.includes(domain)) {
    throw new SsoVerificationError(`SSO assertion email domain "${domain}" is not verified for this organization.`)
  }
  return {
    orgId: config.orgId,
    idpSubject: ssoStableSubject(assertion.issuer, assertion.subject),
    email: assertion.email,
    displayName: assertion.displayName?.trim() || null,
  }
}

// PURE: build the cloud principal a verified SSO identity should bootstrap as. The
// principal is then passed to principal-service.ensurePrincipal, which resolves the
// account/membership → effective permissions exactly like every other login.
export function ssoIdentityToPrincipal(identity: SsoMappedIdentity, orgName: string): CloudPrincipal {
  return {
    tenantId: identity.orgId,
    orgId: identity.orgId,
    tenantName: orgName,
    userId: identity.idpSubject,
    accountId: identity.idpSubject,
    email: identity.email,
    role: 'member',
    authSource: 'user',
    ssoVerified: true,
  }
}
