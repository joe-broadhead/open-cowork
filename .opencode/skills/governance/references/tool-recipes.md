# Governance Tool Recipes

## Deterministic audit sequence

1. `health` (preflight)
2. `list_entities` (frozen scope)
3. `get_metadata_score` project pages (`limit` + `offset`) for baseline
4. `get_metadata_score` entity for deterministic pass/fail
5. `get_undocumented` + `get_test_coverage` for blocker details
6. `get_entity` for owner and governance field verification
7. `reload_manifest` + `health` for recheck

## Preflight

```json
{"name":"health","arguments":{}}
```

If not ready:

```json
{"name":"reload_manifest","arguments":{"manifest_uri":"dbfs:/FileStore/projects/.../manifest.json","refresh_secs":300}}
```

## Scope inventory

Use explicit filters and keep scope stable between runs.

```json
{"name":"list_entities","arguments":{"resource_type":"model","package":"my_dbt_project","detail":"standard","limit":500}}
```

## Project baseline with deterministic paging

Page 1:

```json
{"name":"get_metadata_score","arguments":{"scope":"project","persona":"governance","resource_types":["model"],"limit":200,"offset":0,"include_breakdown":false,"include_recommendations":false}}
```

Page 2:

```json
{"name":"get_metadata_score","arguments":{"scope":"project","persona":"governance","resource_types":["model"],"limit":200,"offset":200,"include_breakdown":false,"include_recommendations":false}}
```

Continue while `offset + count < total_available`.

## Entity gate check (decision source)

```json
{"name":"get_metadata_score","arguments":{"id_or_name":"model.package.model_name","resource_type":"model","scope":"entity","persona":"governance","include_breakdown":true,"include_recommendations":true}}
```

Required decision fields:
- `overall_score`
- `grade`
- `categories`
- `recommendations`

## Gap detail extraction

Undocumented:

```json
{"name":"get_undocumented","arguments":{"resource_type":"model","include_columns":true,"limit":200}}
```

Tests:

```json
{"name":"get_test_coverage","arguments":{"id_or_name":"model.package.model_name","include_full":false}}
```

Owner/governance meta verification:

```json
{"name":"get_entity","arguments":{"id_or_name":"model.package.model_name","resource_type":"model","detail":"standard"}}
```

## Governance persona triage payload (optional accelerator)

```json
{"name":"search","arguments":{"query":"gdpr pii sensitive","persona":"governance","resource_types":["model","source"],"detail":"standard","limit":20}}
```

Use `persona_payload` for triage hints (`policy_risk`, `gate_status`, `blocking_reasons`) but verify blockers with entity-scoped tools before final decisions.
