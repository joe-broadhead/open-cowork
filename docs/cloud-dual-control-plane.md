# Cloud dual control-plane tax (accepted cost)

**Status:** Accepted cost (JOE-870). Full dual memory + Postgres control-plane
implementations are necessary for local tests vs multi-tenant production.

## Why dual stores stay

| Store | Role |
| --- | --- |
| In-memory control plane | Deterministic unit/integration tests, single-process dev, no Postgres dependency |
| Postgres control plane | Production multi-replica durability, tenant isolation, SSE fan-out |

Contracts live under `packages/cloud-server/src/control-plane-*` and domain
mappers under `postgres-domains/` / `control-plane-domains/`. Both backends
implement the same store contract; feature drift is a bug.

## Noise we remove

- Pure re-export shells (e.g. former `services/projection-service.ts`) are deleted;
  barrels re-export the real module (`session-projection-service`).
- Type-only domain Picks should not grow into empty modules — keep domain files
  as real contracts or delete them.

## Facade shrink plan (ratchets)

Oversized facades are ratcheted in `tests/cloud-modularity-boundaries.test.ts`:

| Module | Goal |
| --- | --- |
| `app.ts` | Bootstrap only; route registration and domain wiring extracted into helpers |
| `session-service.ts` | Orchestration facade over `domains.*` sub-services — no new CRUD forwards |
| `postgres-control-plane-store.ts` | Domain modules under `postgres-store-domains/` own SQL |

When a facade shrinks, **lower** its budget; never raise without a documented
backlog. Prefer extracting pure helpers (delta coalescers, path builders) over
rewriting store semantics.

## Keep green

- `tests/cloud-control-plane-domain-contracts.test.ts`
- `tests/cloud-modularity-boundaries.test.ts`
- store contract suites for memory and Postgres
