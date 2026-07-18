---
title: ADR — Monorepo privacy policy (Gateway + Wiki)
description: Decision for bringing private Gateway and Wiki history into the public open-cowork monorepo.
---

# ADR: Monorepo privacy policy (Gateway + Wiki)

| Field | Value |
| --- | --- |
| Status | **Accepted** |
| Date | 2026-07-18 |
| Linear | [JOE-899](https://linear.app/joe-broadhead/issue/JOE-899) |
| Milestone | Monorepo product partitions (Gateway + Wiki) |

## Context

- [open-cowork](https://github.com/joe-broadhead/open-cowork) is a **public** MIT repository.
- [opencode-gateway](https://github.com/joe-broadhead/opencode-gateway) and [open-wiki](https://github.com/joe-broadhead/open-wiki) are **private** repositories today.
- The monorepo plan places them under `products/gateway` and `products/wiki` with history-preserving import.

Importing private git history into a public remote is effectively irreversible without expensive history rewrites and still risks leaked secrets, private ops notes, and unintended licensing.

## Decision

**Option 1 — Open-source Gateway and Wiki into the public open-cowork monorepo under MIT**, after mandatory public-readiness gates.

Rationale:

1. Open Cowork is the flagship public product; a single public monorepo matches the product family story.
2. Private monorepo (option 2) would demote or fork the public OSS surface and complicate GitHub Pages / community contribution.
3. Submodules / private-only packages (option 3) preserve privacy but destroy monorepo DX and were rejected for this milestone.

History import (subtree/merge) **must not** open until the gates below pass for each source repo.

## What may enter public history

| Allowed after gates | Forbidden |
| --- | --- |
| Application source under MIT | Secrets, tokens, private keys, `.env*` with real values |
| Public docs, schemas, tests, packaging scripts | Customer data, private beta customer names, private runbooks with infra credentials |
| Release tooling (install.sh, dockerfiles without secrets) | Unredacted production hostnames/IPs tied to private deploys |
| CHANGELOG / CONTRIBUTING / SECURITY suitable for public | Internal-only commercial terms or private partner agreements |

If a file is ambiguous, **do not import** until reviewed and scrubbed or rewritten.

## Public-readiness gates (blocking)

Before any history-preserving import PR for a product:

1. **Secret scan** of the source repo (full history), using at least one of:
   - `gitleaks detect --source <repo> --log-opts="--all"`
   - `trufflehog git file://<repo> --only-verified` (or equivalent)
2. **Scan report** attached to the import Linear issue (or stored under a non-secret evidence path in the PR).
3. **License pass**: confirm third-party notices remain MIT-compatible; add `LICENSE` / notices as needed under monorepo policy.
4. **SECURITY.md / support boundary**: public security reporting path matches open-cowork.
5. **Ops scrub**: remove or rewrite private deploy paths, personal machine paths, and non-public service URLs from default docs/config samples.
6. **ADR re-check**: product partitions and Knowledge-vs-Wiki ADRs still apply.

Skeleton paths (`products/*/README.md` stubs), Channel Gateway renames, CI scaffolding, and docs-only work **may** land on the public monorepo **without** importing private product source.

## If a gate fails

- Fix in the private source repo first (history rewrite or delete secrets + rotate credentials).
- Re-scan full history.
- Do not land a partial import of “clean tree only” while leaving dirty history reachable via the same remote object set unless using a **new orphan root** import of a scrubbed snapshot (document that loss of history is intentional).

## Consequences

- Gateway and Wiki become public OSS products under the Open Cowork monorepo brand once imported.
- Old private repos freeze and archive after monorepo is source of truth (see JOE-915).
- npm/bin names follow the product partitions ADR (`cowork-gateway`, `cowork-wiki`).

## Non-goals

- Making open-cowork private.
- Hybrid submodule layout for Gateway/Wiki in this milestone.
- Completing the import in this ADR.

## Related

- [Product partitions ADR](product-partitions.md)
- [Knowledge vs Wiki ADR](knowledge-vs-wiki.md)
- [Packaging and product modes](../packaging-and-product-modes.md)
