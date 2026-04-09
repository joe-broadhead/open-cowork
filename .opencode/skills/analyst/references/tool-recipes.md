# Analyst Tool Recipes

## Table of contents

- Discovery
  - Search for metrics (start here)
  - Search by Nova fields
- Inspection
  - Inspect entity
  - Inspect columns
  - Inspect SQL
- Trust and lineage
  - Upstream lineage
  - Column lineage
  - Test coverage
  - Metadata score
- Execution
  - Validate filter values
  - Execute final SQL
  - Health check
- Publishing
  - Create Google Sheet
  - Add data to Sheet
  - Send email

## Discovery

### Search for metrics (start here)
**When:** Beginning any analysis.
**Why:** Analyst persona prioritizes well-documented models.

```json
{"query":"conversion rate","persona":"analyst","resource_types":["model"],"detail":"standard","limit":10,"include_highlights":true}
```

Key fields: `persona_payload`, `relation_name`, `primary_key_columns`, `description`.

### Search by Nova fields
**When:** You already know the semantic target.
**Why:** Pinpoint models with specific measures/metrics/domains.

```text
nova_measures:sessions
nova_metric:conversion_rate
nova_domains:ecommerce AND nova_use_cases:weekly_report
```

Key fields: meta.nova.* fields present in search highlights.

## Inspection

### Inspect entity
**When:** You need a model definition and metadata.
**Why:** Validate grain, measures, and ownership.

```json
{"name":"get_entity","arguments":{"id_or_name":"model.package.model_name"}}
```

Key fields: description, meta.nova, columns.

### Inspect columns
**When:** Confirm dimensions, PKs, or filter fields.
**Why:** Avoid invalid filters and wrong grain.

```json
{"name":"get_columns","arguments":{"id_or_name":"model.package.model_name"}}
```

Key fields: data_type, meta.primary_key, meta.nova.

### Inspect SQL
**When:** Validate computation logic.
**Why:** Ensure measure expressions are correct.

```json
{"name":"get_sql","arguments":{"id_or_name":"model.package.model_name","compiled":false}}
```

Key fields: SQL expressions for metrics, joins, filters.

## Trust and lineage

### Upstream lineage
**When:** Impact or provenance matters.
**Why:** Confirm sources and upstream dependencies.

```json
{"name":"get_lineage","arguments":{"id_or_name":"model.package.model_name","direction":"upstream","depth":2,"resource_types":["source","model"],"detail":"standard"}}
```

### Column lineage
**When:** A specific column drives a metric.
**Why:** Validate its origin and transformations.

```json
{"name":"get_column_lineage","arguments":{"id_or_name":"model.package.model_name","column_name":"session_date","direction":"upstream","depth":2,"confidence":"medium"}}
```

### Test coverage
**When:** Results need higher trust.
**Why:** Confirm tests exist on key columns.

```json
{"name":"get_test_coverage","arguments":{"id_or_name":"model.package.model_name","include_full":false}}
```

### Metadata score
**When:** You need documentation/trust signal.
**Why:** Explain limitations in outputs.

```json
{"name":"get_metadata_score","arguments":{"id_or_name":"model.package.model_name","scope":"entity","persona":"analyst"}}
```

### Context summary (lean by default)
**When:** You need fast triage without large doc payloads.

```json
{"name":"get_context","arguments":{"id_or_name":"model.package.model_name","lineage_depth":1,"include_columns":true,"include_tests":true,"include_upstream":true,"include_downstream":false,"include_docs":false}}
```

## Execution

### SQL preflight (provider + object access)
**When:** Starting in a new environment or after connection/config changes.

```json
{"name":"execute_sql","arguments":{"preflight_only":true,"preflight_relation":"analytics.orders"}}
```

Key fields: `provider`, `ready`, and `checks[*].ok`.

### Validate filter values
**When:** The question includes geography/segment filters.

```json
{"name":"execute_sql","arguments":{"statement":"select <geo_col>, count(*) as rows from <relation> where <time_col> between <start> and <end> group by 1 order by rows desc limit 50"}}
```

### Execute parameterized SQL
**When:** The query contains dynamic filters.

```json
{"name":"execute_sql","arguments":{"statement":"select * from analytics.orders where order_date between :start_date and :end_date and country_code = :country_code","parameters":{"start_date":"2026-02-01","end_date":"2026-02-07","country_code":"GB"},"row_limit":5000}}
```

### Health check
**When:** After reloads or if queries fail unexpectedly.

```json
{"name":"health","arguments":{}}
```

### Find by path (model scoped)
**When:** You know the folder structure and want models only.

```json
{"name":"find_by_path","arguments":{"path_pattern":"models/**/ecommerce/**","resource_types":["model"],"limit":10,"detail":"standard"}}
```

## Publishing

### Create Google Sheet
**When:** User asks for a report or spreadsheet.

Use the `sheets_create` tool with a descriptive title:
```
Tool: google-workspace_sheets_create
Input: { "title": "Weekly Sales Report - 2026-W14" }
```

### Add data to Sheet
**When:** You have query results to publish.

Use `sheets_append` to add rows. First call adds headers, subsequent calls add data:
```
Tool: google-workspace_sheets_append
Input: { "spreadsheetId": "<id from create>", "values": "Metric,Current,YoY,Delta" }
```

### Send email with results
**When:** User asks to share or email the report.

```
Tool: google-workspace_gmail_send
Input: { "to": "team@company.com", "subject": "Weekly Report", "body": "Report: <sheet URL>" }
```

## End-to-end recipe: "sessions and CR last week for UK, publish to Sheets"

1. `search` with query `"sessions conversion rate ecommerce uk"` and `persona: "analyst"`.
2. `get_entity` on top candidates; choose one execution relation.
3. `get_columns` to pick `<time_col>` and `<geo_col>`.
4. `execute_sql` filter-value validation query to find UK value(s).
5. `execute_sql` final aggregate query with validated value(s).
6. `sheets_create` with title "Sessions & CR - Last Week UK".
7. `sheets_append` with headers and data rows.
8. Return result table, evidence block, and sheet URL.
