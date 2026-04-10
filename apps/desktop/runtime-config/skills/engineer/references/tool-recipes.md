# Engineer Tool Recipes

## Table of contents

- Discovery
  - Search for candidate models
- Impact and lineage
  - Downstream impact
  - Lineage (up/down)
  - Column lineage
- Inspection and validation
  - Inspect entity
  - Inspect columns
  - Inspect SQL
- Quality gates
  - Test coverage
  - Metadata score
  - Undocumented entities
  - Validate DAG
  - Diff entities
- Refresh and readiness
  - Reload manifest
  - Health check

## Discovery

### Search for candidate models
**When:** Starting new feature work or refactors.
**Why:** Reuse before building new models.

```json
{"query":"orders","persona":"engineer","resource_types":["model"],"detail":"standard","limit":10}
```

Key fields: description, tags, meta.nova.

## Impact and lineage

### Downstream impact
**When:** Before changing a model.
**Why:** Understand blast radius.

```json
{"name":"get_impact","arguments":{"id_or_name":"model.package.model_name"}}
```

Key fields: downstream_count, impact_score.

### Lineage (up/down)
**When:** Validating dependencies.
**Why:** Confirm data flow and ownership.

```json
{"name":"get_lineage","arguments":{"id_or_name":"model.package.model_name","direction":"downstream","depth":2,"resource_types":["model"],"detail":"standard"}}
```

Key fields: upstream/downstream nodes.

### Column lineage
**When:** A critical column is changing.
**Why:** Verify transformations.

```json
{"name":"get_column_lineage","arguments":{"id_or_name":"model.package.model_name","column_name":"order_id","direction":"upstream","depth":2,"confidence":"medium"}}
```

Key fields: match_reason, explanation.field_path, confidence.

## Inspection and validation

### Inspect entity
**When:** Reviewing model metadata and grain.
**Why:** Align implementation with requirements.

```json
{"name":"get_entity","arguments":{"id_or_name":"model.package.model_name","detail":"standard"}}
```

Key fields: description, meta.nova, primary_key, columns.

### Context bundle (fast triage)
**When:** You need columns + tests + lineage in one call.
**Why:** Quick read before making changes.

```json
{"name":"get_context","arguments":{"id_or_name":"model.package.model_name","context_mode":"engineer","include_docs":false,"include_sql":false,"lineage_depth":1}}
```

Key fields: entity.columns, tests.summary, upstream.entities, downstream.entities.

### Inspect columns
**When:** Validate inputs and PKs.
**Why:** Prevent grain errors.

```json
{"name":"get_columns","arguments":{"id_or_name":"model.package.model_name"}}
```

Key fields: data_type, meta.primary_key.

### Inspect SQL
**When:** Reviewing transformations.
**Why:** Confirm logic before changes.

```json
{"name":"get_sql","arguments":{"id_or_name":"model.package.model_name","compiled":false}}
```

Key fields: joins, filters, derived fields.

## Quality gates

### Test coverage
**When:** Before shipping.
**Why:** Ensure minimum quality.

```json
{"name":"get_test_coverage","arguments":{"id_or_name":"model.package.model_name","include_full":false}}
```

Key fields: coverage_percentage, columns_without_tests_total, test_types.

### Metadata score
**When:** Release readiness.
**Why:** Enforce documentation completeness.

```json
{"name":"get_metadata_score","arguments":{"id_or_name":"model.package.model_name","scope":"entity","persona":"engineer"}}
```

Key fields: grade, missing_fields.

### Undocumented entities
**When:** Finding documentation gaps.
**Why:** Ensure docs are complete.

```json
{"name":"get_undocumented","arguments":{"resource_type":"model","include_columns":true,"limit":100,"package":"my_dbt_package","path_prefix":"models/intermediate/"}}
```

Key fields: undocumented_entities, undocumented_columns.

### Validate DAG
**When:** After significant changes.
**Why:** Detect cycles or orphaned nodes.

```json
{"name":"validate_dag","arguments":{"detail":"summary"}}
```

Key fields: valid, issue_count, orphaned_total.

### Diff entities
**When:** Comparing two models or versions.
**Why:** Verify change scope.

```json
{"name":"diff_entities","arguments":{"entity1":"model.package.model_name","entity2":"model.package.other_model"}}
```

Key fields: differences, missing fields.

## Refresh and readiness

### Reload manifest
**When:** After compile/build or manifest upload.
**Why:** Ensure Nova indexes latest state.

```json
{"name":"reload_manifest","arguments":{"manifest_uri":"dbfs:///path/to/manifest.json","refresh_secs":300}}
```

### Health check
**When:** After reload.
**Why:** Wait for ready state.

```json
{"name":"health","arguments":{}}
```

Key fields: status, refresh details.
