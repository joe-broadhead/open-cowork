---
name: governance
description: "Runs deterministic dbt metadata governance audits and remediation plans. Use when enforcing metadata standards, scoring model quality, finding undocumented/test gaps, validating required Nova fields, producing compliance evidence, or tracking readiness for release. Includes a fixed workflow: preflight -> scope freeze -> paged scoring -> blocker classification -> remediation -> recheck."
license: MIT
allowed-tools: "mcp__nova__health mcp__nova__reload_manifest mcp__nova__list_entities mcp__nova__batch_get_entities mcp__nova__get_metadata_score mcp__nova__get_undocumented mcp__nova__get_test_coverage mcp__nova__get_entity mcp__nova__search"
metadata:
  owner: "dbt-nova"
  persona: "governance"
  version: "0.0.2"
---

# Governance Skill (dbt-nova)

## Mission

Produce audit outputs that are deterministic, reproducible, and actionable:
- same scope -> same blockers
- explicit gates -> pass/fail decisions
- remediation queue with owners and retest criteria

## Execution contract (required)

1) Preflight (do not skip)
- Run `health`.
- If status is not `ready`, run `reload_manifest` then poll `health` until `ready`.
- Capture manifest identity (`source_uri`, `version`, `hash`) as audit evidence.

2) Scope freeze (required before scoring)
- Define one scope contract:
  - `resource_type` set (usually `model`)
  - package/tag/path filters (if any)
  - explicit allowlist or excluded sets
- Persist this scope in the report so reruns are comparable.

3) Deterministic inventory and scoring
- Use `list_entities` for scoped IDs.
- Score entities using `get_metadata_score`:
  - baseline: `scope: "project"` with explicit `limit` and `offset` paging
  - deterministic pass/fail: per-entity (`scope: "entity"`, `persona: "governance"`)
- Never treat a sampled project score as the final governance decision.

4) Gap extraction
- Use `get_undocumented` for documentation gaps.
- Use `get_test_coverage` for test gaps.
- Use `get_entity` for owner and required metadata verification.
- Use governance `search` payload only as triage support, not as sole audit evidence.

5) Gate classification
- Apply rubric from `references/metadata-rubric.md`.
- Label each entity:
  - `pass`
  - `fail` with blocking reasons
- Blocking reasons must be explicit and machine-checkable.

6) Remediation queue
- Build prioritized actions with owner, expected fix, and retest condition.
- Group by blocker type to reduce context noise (docs, tests, governance fields, ownership).

7) Recheck loop (required after changes)
- Refresh manifest and wait for `health=ready`.
- Re-run the same frozen scope.
- Compare blocker counts and gate outcomes against prior run.

## Output standard (required)

Use `assets/governance-audit-template.md` and always include:
- manifest identity (`source_uri`, `version`, `hash`)
- frozen scope definition
- deterministic gate summary (pass/fail counts)
- top blocking reasons (with counts)
- remediation queue (owner + priority + retest condition)

## Validation checklist (copy and complete)

[ ] Manifest ready and identity captured
[ ] Scope frozen before scoring
[ ] Project scoring executed with explicit pagination
[ ] Entity-level gates computed for decision making
[ ] Undocumented and test gaps captured
[ ] Blocking reasons categorized
[ ] Remediation queue includes owner and retest criteria
[ ] Post-fix rerun uses same scope and compares outcomes

## References

- `references/metadata-rubric.md`
- `references/tool-recipes.md`
- `references/manifest-refresh.md`
