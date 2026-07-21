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
| 3 | **God-module budgets** | JOE-919; JOE-951, JOE-942, JOE-936 | **work-store ≤2000**; **environments ≤1300** (~1262); config/scheduler still under soft budgets |
| 4 | **Channel kernel** | JOE-923; JOE-929, JOE-934, JOE-932 | **Foundation done**; full body migrate progressive |
| 5 | **OpenCode kernel** | JOE-916; JOE-940, JOE-945, JOE-943, JOE-937, JOE-966 | **Foundation done**; Durable V2 progressive |
| 6 | **HA / claim gates** | JOE-931; JOE-963 | **Design + gates done**; not multi-AZ HA |
| 7 | **Wiki audit** | JOE-917; P1 remediations + P2 backlog | **P0/P1 done**; P2 children open |
| 8 | **Private-beta ops package** | JOE-922 | **Done** (public package + gaps) |
| 9 | **WorkspaceSessionPort** | JOE-921 | **Done** |
| 10 | **Audit pointer hygiene** | JOE-964 | **Done** |

## Commits on branch (newest first)

```
ea28479c refactor(JOE-942): supervisor + project-binding helpers
… (earlier JOE-942 alerts/channel/event-append, retention; JOE-921/922/917/… )
```

## Next unfinished work (when continuing)

1. **JOE-942** — work-store façade ≤2000 **done** (~1956).  
2. **JOE-936** — environments façade ≤2000 **done** (~1262; util/lifecycle/backends).  
3. Progressive: channel body migrate, OpenCode Durable V2, wiki P2s.  
4. **Open single PR** when ready to burn Actions once.

## Non-claims

Do not claim multi-AZ HA, full dual-stack delete, Durable Gateway V2 complete, or hosted private-beta **go** from this branch alone (see private-beta go/no-go + HA claim gates).
