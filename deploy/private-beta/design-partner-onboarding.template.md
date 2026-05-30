# Managed BYOK Design-Partner Onboarding Template

Use this template in a private operations tracker for each design partner.
Keep this public file generic: do not commit real org ids, customer names,
domains, prices, cloud account ids, project ids, provider keys, token values,
channel secrets, or support rosters.

## Partner Record

- Private ops ticket:
- Launch profile template: `deploy/private-beta/private-beta-launch-profile.template.json`
- Launch readiness target: `private-beta`
- Release artifact:
- Commit:
- Operator:
- Support owner:
- Date:

## Required Ten-Step Flow

1. **Create or invite org owner**
   - Evidence: owner account exists in invite/closed signup mode.
   - Audit event:

2. **Verify org membership and role**
   - Evidence: owner/admin/member roles match the approved plan.
   - Audit event:

3. **Configure BYOK provider key through write-only endpoint**
   - Evidence: POST/write path accepted key material.
   - Redaction check: GET/read payload returns status, provider, last4, or
     fingerprint only.

4. **Run provider validation or audited override**
   - Evidence: bounded worker-role validation succeeded, or override is linked.
   - Provider id:
   - Validation result:

5. **Issue Desktop token or managed Desktop connection config**
   - Evidence: token is show-once, scoped, expiring, and revocable.
   - Expiry:
   - Scope:

6. **Issue Gateway service token and channel binding when enabled**
   - Evidence: gateway token is scoped to gateway service use only.
   - Channel provider:
   - Signing/HMAC proof:

7. **Confirm Cloud Web workbench bootstrap and admin surface**
   - Evidence: `/`, `/api/config`, `/api/workspace`, admin policy, audit,
     BYOK, billing/usage, and gateway ops surfaces load with expected role
     checks.

8. **Run first synced cloud thread from Web**
   - Evidence: session create, prompt enqueue, SSE/projection update, artifact
     or tool event when available.
   - Session id:

9. **Continue same thread from Desktop**
   - Evidence: Desktop activates the cloud workspace, hydrates the same session
     projection, sends or receives an update, and local workspace remains
     available offline.

10. **Continue or notify through Gateway**
    - Evidence: gateway binds or resumes the same session, renders output,
      resolves a permission/question when present, and advances delivery
      cursor.

## Token Lifecycle Proof

- [ ] Desktop token show-once behavior captured.
- [ ] Desktop token expiry captured.
- [ ] Desktop token revocation blocks next request or SSE reconnect.
- [ ] Gateway service token show-once behavior captured.
- [ ] Gateway service token expiry captured.
- [ ] Gateway service token revocation blocks next request or delivery stream.
- [ ] Revoked/expired token attempts are audited and secret-redacted.

## Secret Redaction Proof

Confirm raw BYOK keys, OAuth refresh/access tokens, API tokens, MCP secrets,
channel secrets, cookie secrets, database URLs, signed object-store URLs, and
local file contents are absent from:

- [ ] GET API payloads.
- [ ] Cloud logs.
- [ ] audit exports.
- [ ] browser state.
- [ ] Desktop cloud cache.
- [ ] Gateway logs.
- [ ] diagnostics bundles.
- [ ] launch reports.

## Blocking Behavior Proof

- [ ] Unsupported provider blocks execution with a clear policy message.
- [ ] Missing BYOK state blocks execution with a clear setup message.
- [ ] Quota pressure returns clear 429/402 responses without spawning workers.
- [ ] Cloud outage leaves local Desktop workspace usable.

## Final Onboarding Decision

- Decision: `{ready|conditional|blocked}`
- Conditions:
- Follow-up issues:
- Support owner:
- Next review date:
