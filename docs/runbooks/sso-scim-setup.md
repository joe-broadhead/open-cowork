# Enterprise SSO (SAML + OIDC) and SCIM provisioning

This runbook covers wiring an organization to an external identity provider (IdP) for
single sign-on and automated user lifecycle (SCIM) in Open Cowork Cloud. The feature is
**per-organization** — each org configures its own IdP and its own SCIM token — and all
IdP secrets are stored encrypted with the cloud envelope-encryption key
(`OPEN_COWORK_CLOUD_SECRET_KEY`), never in plaintext.

> Scope note: the config model, endpoints, sync queue, mapping, and enforcement are fully
> implemented and tested. Completing an end-to-end SAML or OIDC login and a live SCIM sync
> additionally requires **your** IdP metadata, certificates, and secrets — the steps below
> are what an operator wires. OIDC assertion verification reuses the existing verified-JWT
> path; SAML response signature validation is a documented pluggable verifier seam
> (`SsoAssertionVerifier`) you supply with your IdP signing certificate.

## Prerequisites

- The cloud control plane is running with a **durable Postgres** control plane and
  `OPEN_COWORK_CLOUD_SECRET_KEY` (or `..._REF`) set — required to seal IdP secrets.
- You are an **owner or admin** of the org (SSO config CRUD requires the `sso:manage`
  permission, held by owner/admin and assignable to custom roles).
- No new environment variables are introduced by this feature; configuration is entirely
  per-org via the admin API below.

## 1. Configure SSO

SSO config is managed under `POST /api/admin/sso`. A request merges a partial patch onto
the current record, so you can set fields incrementally.

### OIDC

```bash
curl -X POST "$CLOUD/api/admin/sso" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{
    "protocol": "oidc",
    "enabled": true,
    "verifiedDomains": ["example.com"],
    "oidcIssuer": "https://<idp-issuer>",
    "oidcClientId": "<client-id>",
    "oidcClientSecret": "<client-secret>"
  }'
```

The response never echoes the secret — it reports `hasOidcClientSecret: true`. The secret
is sealed as `enc:v1:` ciphertext in the store.

### SAML 2.0

```bash
curl -X POST "$CLOUD/api/admin/sso" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{
    "protocol": "saml",
    "enabled": true,
    "verifiedDomains": ["example.com"],
    "samlEntityId": "https://<cloud-host>/saml/metadata",
    "samlAcsUrl": "https://<cloud-host>/saml/acs",
    "samlSloUrl": "https://<cloud-host>/saml/slo",
    "samlIdpEntityId": "<idp-entity-id>",
    "samlIdpSsoUrl": "https://<idp>/sso",
    "samlIdpMetadataUrl": "https://<idp>/metadata",
    "samlIdpCertificate": "-----BEGIN CERTIFICATE-----\n..."
  }'
```

### SSO-only enforcement

Set `"enforced": true` to require SSO for the org's verified domains. Once enforced, a
non-SSO (OIDC-end-user) login for an address in a verified domain is rejected — members
must come through the IdP. Local/self-host logins and already-SSO-verified principals are
exempt, so deployments without enterprise SSO are unaffected.

### Domain verification

The config carries a `domainVerificationToken`. Prove domain ownership out of band (e.g. a
DNS TXT record containing the token) before adding a domain to `verifiedDomains`; the
verified-domain list is what routes a login to its org and gates SCIM/SSO email matching.

## 2. Per-IdP notes

| IdP | Metadata / issuer | Claim / attribute mapping | SCIM |
| --- | --- | --- | --- |
| **Okta** | OIDC: `https://<org>.okta.com/oauth2/default`; SAML metadata from the app's "Sign On" tab | email → `email`, subject → `sub` / NameID; groups → group `displayName` | Enable "Provisioning", base URL `https://<cloud-host>/scim/v2`, token from step 3 |
| **Microsoft Entra ID** | OIDC: `https://login.microsoftonline.com/<tenant>/v2.0`; SAML from the enterprise app | email → `email`/`preferred_username`, subject → `sub`/`oid` | Provisioning → SCIM, tenant URL `https://<cloud-host>/scim/v2`, Secret Token from step 3 |
| **Google Workspace** | OIDC issuer `https://accounts.google.com`; SAML from the custom SAML app | email → `email`, subject → `sub`; verify the hosted domain (`hd`) | Google auto-provisioning maps to `/scim/v2/Users` |

For SAML, map the IdP's group attribute so a group named `owner`, `admin`, or `member`
maps onto the corresponding built-in role during SCIM group sync.

## 3. Enable SCIM provisioning

Issue the org's SCIM bearer token (this also enables SCIM):

```bash
curl -X POST "$CLOUD/api/admin/sso/scim-token" -H "authorization: Bearer $ADMIN_TOKEN"
# => { "config": { ... }, "scimToken": "scim_..." }   # shown ONCE
```

Store only the hash server-side; paste the returned `scimToken` into your IdP's SCIM
configuration. Re-running the call rotates the token (invalidating the previous one).

**SCIM base URL:** `https://<cloud-host>/scim/v2`

Supported resources:

- `GET/POST /scim/v2/Users`, `GET/PUT/PATCH/DELETE /scim/v2/Users/{id}`
- `POST/PUT/PATCH /scim/v2/Groups`
- `GET /scim/v2/ServiceProviderConfig`

Provisioning maps SCIM → account/membership/role. **Deprovisioning** (`active:false` via
PATCH, or `DELETE`) suspends the membership **and immediately revokes that member's issued
credentials**, so access is cut on the next request.

## 4. Durability and reconciliation

Every SCIM write also lands a row in a durable, store-backed sync-event queue and is
re-applied idempotently. A transient failure is retried with exponential backoff (up to 5
minutes, 8 attempts), and the scheduler periodically drains the queue and runs a drift
reconciliation that re-converges directory state with membership state — provisioning is
**not** best-effort. Failed events are visible for triage; a stuck event (`status: failed`)
indicates the target directory state could not be applied and should be investigated.

## Troubleshooting

- **"Storing SSO secrets requires envelope encryption"** — set `OPEN_COWORK_CLOUD_SECRET_KEY`.
- **SCIM 401** — the bearer token is wrong or SCIM is disabled; rotate via step 3.
- **Login rejected with "requires SSO login"** — enforcement is on for that domain; sign in
  through the IdP or clear `enforced`.
- **SAML "verification is not configured"** — supply an `SsoAssertionVerifier` for the
  `saml` protocol wired to your IdP signing certificate (the default seam fails closed).
