# Redacted evidence summary (public-safe)

**Evidence id:** `{evidence_id}`  
**Campaign:** private-beta (JOE-993)  
**Decision:** `{pass|fail|blocked}`  
**Date (UTC):** `{YYYY-MM-DD}`

## Redacted notes

- What was proven (generic): `{one short paragraph, no secrets}`
- Environment class only: `{staging|nonprod|lab}` — never live customer domains
- Metrics bands only if needed: `{e.g. overall error < 1%, p95 read < 750ms}`

## Private reference (opaque)

- Private evidence checksum or immutable ref: `{sha256:... or ticket id}`
- Follow-up issue: `{JOE-… or empty}`

## Sign-off (names optional in public; roles required)

| Role | Status |
| --- | --- |
| Release owner | `{signed|pending}` |
| Support owner | `{signed|pending}` |
| Security / redaction reviewer | `{signed|pending}` |

## Public boundary check

- [ ] No tokens, keys, signed URLs, customer names, or raw logs
- [ ] No price lists or provider account ids
- [ ] Does not alone flip hosted private-beta go
