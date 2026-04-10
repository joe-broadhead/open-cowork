---
name: engineer
description: "Builds and modifies dbt models with quality gates. Use when creating models, refactoring SQL, adding columns, designing metrics, analyzing downstream impact, adding tests, improving documentation, or shipping production-ready dbt code. Supports impact analysis, test coverage validation, and metadata scoring."
license: MIT
allowed-tools: "mcp__nova__search mcp__nova__get_entity mcp__nova__get_columns mcp__nova__get_sql mcp__nova__get_lineage mcp__nova__get_column_lineage mcp__nova__get_context mcp__nova__get_impact mcp__nova__get_test_coverage mcp__nova__get_metadata_score mcp__nova__get_undocumented mcp__nova__reload_manifest mcp__nova__health mcp__nova__diff_entities mcp__nova__validate_dag Read"
metadata:
  owner: "dbt-nova"
  persona: "engineer"
  version: "0.0.2"
---

# Engineer Skill (dbt-nova)

## When to use

Use this skill for requirements that involve building or changing dbt models, refactoring, or shipping new metrics.

## Core workflow (required)

1) Understand requirements
- Capture grain, key dimensions, and required outputs.
- Identify existing models that can be extended.

2) Discover existing assets
- Use `search` with persona = engineer.
- Prefer reuse before new models.

3) Impact analysis
- Use `get_lineage` (downstream) and `get_impact` before changes.
- Set `resource_types: ["model"]` in `get_lineage` to avoid tests when you only want model dependencies.
- Identify dependent models and exposures.

4) Validate inputs
- Use `get_sql` and `get_columns` to confirm upstream fields.
- Use `get_column_lineage` for critical columns.
- For fast triage, use `get_context` with `context_mode: "engineer"` and `include_docs: false`.

5) Quality gates
- Use `get_test_coverage` to identify test gaps.
- Ensure documentation coverage for models + columns.

6) Metadata and readiness
- Use `get_metadata_score` (persona = engineer).
- Ensure A-grade or specify remediation steps.
- Use `validate_dag` with `detail: "summary"` after big graph changes to avoid noisy orphan lists.

7) Refresh the manifest (required after changes)
- After dbt compile/build and updating the manifest location, run `reload_manifest`.
- Confirm readiness with `health` before searching.
- See `references/manifest-refresh.md` for exact steps.

## Examples

### Example 1: Adding a column
**User:** "Add `days_since_last_order` to the customer model."

**Workflow:**
1. Search for the customer model
2. Impact analysis (downstream)
3. Validate upstream fields
4. Implement, compile, reload manifest
5. Verify metadata score

**Output (ship checklist):**
- Model: dim_customers
- Column: days_since_last_order
- Downstream: 3 models affected
- Tests needed: not_null, positive_values

### Example 2: Refactor model grain
**User:** "Refactor `fct_orders` to be order-line grain."

**Workflow:**
1. Get lineage and impact
2. Validate source fields
3. Update model, tests, docs
4. Reload manifest and re-check metadata score

## Tool usage (quick map)

- `search` (persona: engineer): discovery
- `get_lineage` / `get_impact`: blast radius
- `get_lineage` supports `resource_types` to filter out tests or limit to models only
- `get_sql` / `get_columns`: input validation
- `get_context` (context_mode: engineer): fast triage bundle
- `get_column_lineage`: column provenance
- `get_test_coverage`: quality gates
- `get_metadata_score`: readiness scoring
- `reload_manifest` / `health`: refresh + readiness
- `get_undocumented` / `diff_entities` / `validate_dag` (detail: summary): quality and change verification

## Output standard (required)

Provide a ship checklist:
- Model name + grain
- Selection rationale (why this entity is the implementation target)
- Columns added/changed
- Tests added/required
- Downstream impact summary
- Metadata score and missing fields

Also include a compact signal block (deterministic):
- `blast_radius_count`
- `change_risk`
- `readiness_band`
- `tests_total`
- `documentation_coverage_pct`
- `missing_required_fields`

Use the checklist template in `assets/ship-checklist.md`.

## Validation checklist (copy and complete)

[ ] Upstream dependencies validated
[ ] Impact analysis reviewed
[ ] Tests added for new columns
[ ] Documentation added
[ ] Metadata score at target
[ ] Manifest reloaded
[ ] Ship checklist completed

## Optional scripts (recommended, not required)

Consider adding these in `scripts/`:
- `lint_model_metadata.py` (enforce Nova fields)
- `impact_snapshot.sql` (quick downstream impact query)
- `test_plan.md` generator

## References

- `references/engineering-workflow.md`
- `references/tool-recipes.md`
- `references/manifest-refresh.md`
