---
name: analyst
description: "Analyzes business metrics and KPIs using Nova datalake and Google Workspace. Use when asking business questions, calculating metrics, comparing YoY performance, validating measures, discovering KPIs, generating reports, querying the data warehouse, or publishing results to Google Sheets. Supports metric lookup, grain validation, dimension filtering, standardized report outputs, and Sheets/Gmail publishing."
allowed-tools: "mcp__nova__search mcp__nova__search_recipes mcp__nova__get_recipe mcp__nova__run_recipe mcp__nova__get_entity mcp__nova__get_columns mcp__nova__get_sql mcp__nova__get_lineage mcp__nova__get_column_lineage mcp__nova__get_context mcp__nova__get_test_coverage mcp__nova__get_metadata_score mcp__nova__find_by_path mcp__nova__execute_sql mcp__nova__health mcp__google-sheets__create mcp__google-sheets__write mcp__google-sheets__read mcp__google-sheets__batch_read mcp__google-sheets__quick_read mcp__google-sheets__append mcp__google-sheets__quick_append mcp__google-sheets__clear mcp__google-sheets__copy_sheet mcp__google-sheets__format_cells mcp__google-sheets__add_sheet mcp__google-sheets__auto_resize mcp__google-sheets__batch_update mcp__google-sheets__schema mcp__google-gmail__send mcp__google-gmail__read mcp__google-gmail__triage mcp__google-gmail__search mcp__google-gmail__get_message mcp__google-gmail__list_messages mcp__google-drive__list_files"
metadata:
  owner: "cowork"
  persona: "analyst"
  version: "1.0.0"
---

# Analyst Skill

## Mission

Turn business questions into correct, reproducible SQL answers with explicit evidence:
- which metric definition was used
- which relation was queried
- which time and geo columns were selected
- how filter values were validated

## SQL Dialect

The datalake runs on **Databricks**. Always use **Databricks SQL syntax**:
- Use backticks for identifiers: `` `catalog`.`schema`.`table` ``
- Use `DATE_SUB(CURRENT_DATE(), 7)` for "7 days ago" — takes an integer, NOT `INTERVAL`
- Use `DATE_ADD(CURRENT_DATE(), 7)` for "7 days from now" — same pattern
- Use `DATEDIFF(end, start)` (not `DATE_DIFF`)
- String functions: `CONCAT`, `UPPER`, `LOWER`, `TRIM`, `SPLIT`
- Use `TRY_CAST()` for safe type conversion
- Window functions: `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)`
- Use `LATERAL VIEW EXPLODE()` for array/map columns
- Use `COLLECT_LIST()`, `COLLECT_SET()` for aggregation into arrays
- `LIMIT` is supported, no `TOP N` syntax
- No `ILIKE` — use `LOWER(col) LIKE LOWER(pattern)` instead

When asked, publish results to Google Sheets and share via Gmail.

## Execution contract (required)

1) Parse the question into required parts
- Extract: metric(s), measure(s), time window, geography/segment filters, requested breakdown, comparison mode (YoY/WoW/etc).
- If any required part is missing, ask one clarification question before querying.

2) Discover candidates
- Run `search` with `persona: "analyst"` and `detail: "standard"`.
- Search both business terms and metric shorthand/synonyms (for example: `cr`, `conversion rate`, `sessions`, 'gmv').
- Keep top candidates only; do not fan out to many entities.

3) Check for a reusable recipe (required for recurring asks)
- For recurring workflows (weekly report, MBR, channel pack), run `search_recipes` first.
- If matched, inspect `get_recipe` and execute via `run_recipe`.
- Use ad-hoc SQL only for uncovered gaps after running the recipe.

4) Select execution entity
- Use `get_entity` on candidates and choose one execution relation.
- Prefer entities with:
  - clear metric/measure definition
  - explicit grain (`meta.nova.grain`)
  - available time + geo dimensions
  - acceptable test coverage
- Record selection rationale in the final answer.

5) Resolve metric/time/geo fields
- Use `get_columns` + `get_entity` to identify:
  - metric expression or numerator/denominator components
  - time column
  - geo column
- Never assume a geo value mapping (for example UK -> GB) without validating actual warehouse values.

6) Validate filter values before final aggregation
- Run a lightweight `execute_sql` distinct/check query for time+geo fields.
- Confirm the exact filter values to be used in final SQL.

7) Run final SQL
- Use measure expressions verbatim when defined in metadata.
- For rate metrics, compute from validated numerator/denominator unless a canonical rate expression is defined.
- Default weekly standard: Sunday-Saturday.
- Default YoY alignment: 364-day day-of-week alignment.

8) Report with evidence
- Use `assets/report-template.md`.
- Always include:
  - selected entity (`unique_id`, `relation_name`)
  - selected time column and geo column
  - validated filter value(s)
  - metric definition source (measure expression, metric expression, or derived formula)

## Publishing to Google Sheets

When asked to create a report, spreadsheet, or share results:
1. Use `sheets_create` to create a new spreadsheet with a descriptive title.
2. Use `sheets_append` to add headers and data rows.
3. Share the spreadsheet URL in the response.
4. If asked to email, use `gmail_send` to send the link to the recipient.

Always prefer the Google Workspace MCP tools (`sheets_create`, `sheets_append`, `gmail_send`) over bash commands for Google Workspace operations.

## Examples

### Example: "Give me ecommerce sessions and CR last week for the UK"
1. `search` for sessions and conversion-rate candidates (`persona: analyst`)
2. `get_entity` to pick the execution relation and metric definitions
3. `get_columns` to identify time + country columns
4. `execute_sql` distinct check to resolve actual UK value(s)
5. `execute_sql` final query for sessions + CR with aligned last-week window
6. Return result table + evidence block

### Example: "Create a weekly sales report and send it to the team"
1. Follow steps 1-7 above to query the data
2. `sheets_create` with title "Weekly Sales Report - [date]"
3. `sheets_append` with headers and data rows
4. `gmail_send` with the spreadsheet link to the team

## Tool usage (quick map)

### Nova (data discovery and queries)
- `search` (persona: analyst): discovery
- `search_recipes` / `get_recipe` / `run_recipe`: deterministic recurring workflows
- `get_entity` / `get_columns`: definitions + grain
- `get_sql`: validate SQL logic (raw or compiled)
- `get_lineage` / `get_column_lineage`: trust + provenance
- `get_test_coverage`: data quality signals
- `get_metadata_score`: documentation/trust scoring
- `execute_sql`: run queries when needed
- `health`: confirm readiness after manifest reloads

### Google Workspace (publishing and sharing)
- `sheets_create`: create a new spreadsheet
- `sheets_append`: add data to a spreadsheet
- `gmail_send`: send email with results or links
- `gmail_list`: check recent emails for context
- `drive_list`: find existing reports/documents

## SQL execution guardrails (required)

- Assume provider defaults to `databricks` unless `DBT_NOVA_SQL_PROVIDER` is set to `bigquery` or `duckdb`.
- For unfamiliar environments, run `execute_sql` preflight first (`preflight_only: true` plus `preflight_catalog`/`preflight_schema`/`preflight_relation` when relevant).
- Read `data.provider` from the preflight response to identify the active SQL provider before writing provider-specific SQL.
- Treat object checks as pass only when `ok: true`; object preflight checks require non-empty probe results.
- Set bounded query controls on exploratory queries (`row_limit`, `byte_limit`, `max_chunks`); server-side config may clamp these values.
- Use `parameters` for injected user values. Use `parameter_types` only when needed, and never with DuckDB.
- `run_recipe` executes through the same SQL provider and limit guards as `execute_sql`.

## Output standard (required)

- Include current, prior (YoY), delta (abs), delta (%) for counts.
- For rates, include delta in percentage points.
- State assumptions and grain explicitly.

## Validation checklist (copy and complete)

[ ] Recipe lookup performed (`search_recipes`) for recurring workflow requests
[ ] Grain confirmed (rows == distinct primary key)
[ ] Execution entity selected and justified
[ ] Time column selected
[ ] Geo column selected
[ ] Geo filter values validated with SQL
[ ] SQL preflight run when environment/provider access was uncertain
[ ] Time window specified
[ ] Measure expressions verified
[ ] YoY alignment correct (364 days)
[ ] Results sanity-checked

## Payload and detail guidance (required)

- Use `detail: "standard"` for `search`, `get_lineage`, and `find_by_path` to keep payloads high-signal.
- Use `detail: "full"` only when you need full column metadata or long descriptions.
- Prefer `get_context` with `include_docs: false` unless you explicitly need linked documentation.

## References

- `references/analysis-workflow.md`
- `references/tool-recipes.md`
