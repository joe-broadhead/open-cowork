# Knowledge store ownership

Open Cowork keeps a **single** `KnowledgeStore` contract
([`packages/shared/src/knowledge-store-contract.ts`](../packages/shared/src/knowledge-store-contract.ts))
with two production backends. The dual implementation is intentional: desktop
and cloud have different durability and multi-tenant requirements. Feature
logic must land on the shared contract (or shared helpers) so behavior does not
drift.

## When each store is used

| Backend | Module | Used by | Durability model |
| --- | --- | --- | --- |
| SQLite (`node:sqlite`) | `packages/runtime-host/src/knowledge/knowledge-store.ts` → `createSqliteKnowledgeStore` | Desktop / local runtime host | Single-process, on-disk per user data directory |
| Postgres | `packages/runtime-host/src/knowledge/postgres-knowledge-store.ts` → `createPostgresKnowledgeStore` | Cloud control plane (`packages/cloud-server`) | Multi-replica, tenant-scoped rows |

Callers always `await` store methods. The contract uses `MaybePromise<T>` so the
same API works for the synchronous SQLite path and the async Postgres path.

## Shared contract rules

1. **Do not** add product behavior only to one backend. Prefer:
   - contract methods on `KnowledgeStore`
   - pure helpers in `@open-cowork/shared` / `@open-cowork/shared/node` (validation,
     row mappers, seed, diff/graph derivation)
2. Storage-agnostic helpers already live in shared code so cloud Postgres does
   not import the desktop SQLite module.
3. Tests that lock dual-backend parity should exercise the contract (snapshot,
   proposal/review, history) against both factories when behavior changes.
4. Cloud wiring constructs the Postgres store in `packages/cloud-server/src/app.ts`.
   Desktop constructs SQLite through runtime-host knowledge services.

## Anti-drift checklist

When changing Knowledge:

- [ ] Update the shared contract if the API surface changes
- [ ] Implement both backends (or explicitly document temporary single-backend
      support with a tracking issue)
- [ ] Keep MCP knowledge tools (`mcps/knowledge`) talking to the host-provided
      store, not a third ad-hoc store
- [ ] Avoid embedding SQL or SQLite pragmas in UI or MCP packages

See also [OpenWiki](openwiki.md) for the external docs CLI boundary (not a third
in-product knowledge store).
