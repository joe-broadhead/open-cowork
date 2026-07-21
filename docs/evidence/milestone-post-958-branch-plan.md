# Post-#958 milestone branch plan (single PR)

**Branch:** `fix/milestone-post-958-quality-signal`  
**Base:** `master` @ PR #958 merge  
**Policy:** One PR at the end of the milestone (GitHub Actions minutes). Commits land per issue or tightly related issue group.

## Commit rules

1. Prefer **one commit per Linear issue** when the change is isolated.
2. **Group issues into one commit** when they share the same files/tests and split commits would be noise (example: JOE-924+JOE-925 eval bridge).
3. Do **not** open intermediate PRs for this branch until the milestone group is ready.
4. PR description will map commit → issue IDs for review.

## Groups (execution order)

| # | Group | Epic / issues | Branch status |
| --- | --- | --- | --- |
| 1 | **Quality signal** | JOE-918; JOE-924, JOE-925, JOE-926, JOE-933 | **Done** (commits on branch) |
| 2 | **Security residuals** | JOE-920; JOE-952, JOE-957, JOE-946, JOE-962 | **Mostly done** (946 CSP locked docs; deeper CSP optional residual) |
| 3 | **God-module budgets** | JOE-919; JOE-951, JOE-942 (+ further splits) | **In progress** (budgets + work-store extracts; façade still ~4.9k) |
| 4 | **Channel kernel** | JOE-923; JOE-929, JOE-934, JOE-932 | **Foundation done**; full body migrate progressive |
| 5 | **OpenCode kernel** | JOE-916; JOE-940, JOE-945, JOE-943, JOE-937, JOE-966 | **Foundation done**; Durable V2 progressive |
| 6 | **HA / claim gates** | JOE-931; JOE-963 | **Design + gates done**; not multi-AZ HA |
| 7 | **Wiki audit** | JOE-917; P1 remediations + P2 backlog | **P0/P1 done**; P2 children open |
| 8 | **Private-beta ops package** | JOE-922 | **Done** (public package + gaps) |
| 9 | **WorkspaceSessionPort** | JOE-921 | **Done** |
| 10 | **Audit pointer hygiene** | JOE-964 | **Done** |

## Commits on branch (newest first)

```
76c0928d refactor(JOE-942): work-store alerts, channel-bindings, event-append
30c8f62b feat(JOE-921): WorkspaceSessionPort + parity
99b83b58 docs(JOE-922): private-beta ops evidence package
0f28fb88 feat(JOE-917): wiki deep audit + P1 guards
8b903d45 feat(JOE-931): HA design + claim gates
28b29218 feat(JOE-940,945,943,937,966): OpenCode kernel group
84915c98 feat(JOE-934,932): channel webhook security kernel
e9dab06a docs(JOE-929): dual-stack inventory
7050850e chore(JOE-951): hard LOC budgets
ace50f1b refactor(JOE-942): work-store retention + storage-lock
1a9495e4 test(JOE-952): vitest unredacted export guard
20ffa6a3 chore(JOE-957): monthly audit:full process
251dcf6c docs(JOE-946,962): chart CSP + MCP HTTPS residual
9cf313a3 fix(JOE-952): rate-limit/audit unredacted exports
399fb5e8 fix(JOE-925): smoke approvals harden
130dab2a docs(JOE-933): monthly UI eval runbook
d907e518 feat(JOE-926): consecutive monthly eval alert
6215901d fix(JOE-924,925): E2E eval bridge (admin nav + approvals)
```

## Next unfinished work (when continuing)

1. **JOE-942** — further work-store domain extracts until ≤2000 LOC (supervisors, project-bindings, task dispatch).  
2. **JOE-936** etc. — other named god modules under JOE-919.  
3. Progressive: channel body migrate, OpenCode Durable V2, wiki P2s.  
4. **Open single PR** when ready to burn Actions once.

## Non-claims

Do not claim multi-AZ HA, full dual-stack delete, Durable Gateway V2 complete, or hosted private-beta **go** from this branch alone (see private-beta go/no-go + HA claim gates).
