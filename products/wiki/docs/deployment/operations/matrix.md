# Operations Matrix

| Runtime | Canonical data | Derived state | Required operating evidence |
| --- | --- | --- | --- |
| Personal local | Local Git workspace | SQLite and local files | Personal doctor, verified backup, restore rehearsal |
| Trusted team, single node | Persistent Git workspace | SQLite or Postgres | Hosted doctor, authenticated boundary, backup and readiness probes |
| Hosted or enterprise, source-operated | Persistent Git workspace | Postgres read/search/queue/operational state; optional object storage | Hosted doctor, per-replica health/metrics, shared write coordination, database/object-storage backups, restore rehearsal |
| Public static | Source Git workspace | Generated static directory | Static export report and artifact checks |

## Common Checks

```sh
openwiki --root <wiki> doctor --profile personal --json
openwiki --root <wiki> doctor --profile hosted --json
openwiki --root <wiki> backup create --verify --json
openwiki --root <wiki> backup rehearse --target-root <disposable-path> --json
curl --fail http://127.0.0.1:3030/livez
curl --fail http://127.0.0.1:3030/readyz
```

The monorepo does not provide platform deployment evidence. Operators running
from source must add infrastructure-specific install, monitoring, backup, and
rollback proof outside this product contract.
