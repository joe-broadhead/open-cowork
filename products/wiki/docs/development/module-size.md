# Module size budget

OpenWiki keeps production implementation modules below 800 lines of code. Files
above 500 lines are visible in the module-size report so they can be split when
the next local seam appears.

Run:

```sh
pnpm check:modules
```

## Current exceptions

| File | Reason | Next split |
| --- | --- | --- |
| `tests/adapters-http-readiness.test.ts` | This is one broad HTTP API smoke path that verifies capabilities, OpenAPI, health, pages, graph, search, jobs, and server startup against one shared fixture. Splitting it safely needs route-fixture helpers so coverage is not weakened by duplicated setup. | Extract HTTP route fixtures, then split into discovery, content, graph/search, jobs, and server-start suites. |
| `scripts/openwiki-opencode-tool-evals.mjs` | This is an end-to-end eval runner where scenario definitions, workspace seeding, OpenCode invocation, and runtime verification are still coupled by shared temporary workspace state. | Extract scenario definitions, workspace setup, runner, verification, and report modules under `scripts/opencode-tool-evals/`. |

These exceptions are not permanent. They are intentionally checked into the
report so future hardening work can remove them one at a time.
