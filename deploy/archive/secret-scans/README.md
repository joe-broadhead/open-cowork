# Secret scan evidence (monorepo import)

Scanned before P2 product import (JOE-899 / JOE-906 / JOE-907).

| Source repo | Commit | Tool | Result |
| --- | --- | --- | --- |
| joe-broadhead/opencode-gateway | `e57831aae755ee64b8d3892f53ef5f110987475b` | gitleaks 8.30.1 full history | 5 findings — **false positives** (synthetic test fixtures only; see disposition) |
| joe-broadhead/open-wiki | `03f3d797c1a0687904af57bd53c80d518e06412e` | gitleaks 8.30.1 full history | **0 findings** |

## Gateway disposition

All hits are under `src/__tests__` with clearly synthetic strings:

- `legacy-delegation-key-1`, `legacy-route-dedupe-1` — SQLite fixture keys
- `Xk7pQ2rL9wMv3ZtB6nD4hJ8sF1aY0cG` — test token strength fixture
- `delegate_partial_wf4` — dogfood idempotency key label
- `sk-secret123456` — redaction test needle (not a live credential)

**Import method:** scrubbed **tree snapshot** of the commits above (no full private history replay into public monorepo). Intentional history loss documented here per monorepo-privacy ADR.

## Re-run

```bash
gitleaks detect --source <repo> --log-opts="--all" --report-format json --report-path report.json
```
