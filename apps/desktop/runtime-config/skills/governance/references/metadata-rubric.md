# Governance Metadata Rubric

## Decision model

Governance decisions are binary per entity:
- `pass`
- `fail` (with explicit blocking reasons)

Use this rubric together with `get_metadata_score` (`scope: "entity"`, `persona: "governance"`).

## Pass criteria (default)

1. `overall_score >= 90` (A-grade)
2. Required Nova fields are present:
   - `nova.domains`
   - `nova.use_cases`
   - `nova.synonyms`
   - `nova.tier`
   - `nova.governance.sensitivity`
   - `nova.governance.pii`
   - `nova.governance.compliance`
3. Documentation coverage is acceptable (`columns_documented / columns_total >= 0.80`)
4. Tests exist for the entity (`model_tests + column_tests > 0`)
5. Owner exists (`meta.owner`)
6. If PII exists, compliance tags must be non-empty

## Canonical blocking reasons

Use these exact labels in reports:
- `missing_required_nova_fields`
- `metadata_score_below_a_grade`
- `documentation_coverage_below_threshold`
- `test_coverage_missing`
- `owner_missing`
- `pii_without_compliance_tags`

## Priority policy

- P0: PII/compliance blockers (`pii_without_compliance_tags`)
- P1: Missing required fields / owner missing
- P2: Documentation threshold failures
- P3: Test coverage gaps when other blockers are clear

## Evidence required for each fail

- entity `unique_id`
- blocker labels (from canonical list)
- current score/grade
- missing fields or gap metrics
- owner (or owner missing)
- concrete remediation action and retest condition
