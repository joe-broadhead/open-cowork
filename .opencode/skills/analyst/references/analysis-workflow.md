# Analyst Workflow Details

## Deterministic sequence (required)

1. Identify requested metrics and filters from the user question.
2. Select one execution entity (metric model or base model).
3. Resolve required columns: metric inputs, time column, geo/segment columns.
4. Validate filter values with a short SQL check.
5. Run final SQL.
6. Report numbers plus selection evidence.

Do not skip step 4 when the question includes geography or segment filters.

## Clarification prompt

Use this when any key input is ambiguous:

"To confirm: I will compute `<metric list>` from `<candidate entity>` at `<grain>` filtered by `<filters>` over `<time window>`. If this should use a different entity, grain, or filter mapping, tell me before I run SQL."

## Entity selection rubric

Prefer the candidate that satisfies the most checks:
- has explicit measure/metric definition
- has known grain
- contains required time + geo columns
- has acceptable tests/docs

If two candidates tie, pick the one with clearer definitions and fewer assumptions.

## Grain validation query

```sql
select
  count(*) as rows,
  count(distinct <primary_key>) as distinct_pk
from <relation>
where <time_filter>;
```

Interpretation:
- `rows == distinct_pk`: row-level grain is primary-key grain
- `rows > distinct_pk`: relation is already aggregated or duplicated by joins

## Time standards (default)

- Week: Sunday-Saturday
- YoY: 364-day shift (day-of-week aligned)
- Use same-date YoY only when explicitly requested
- Prefer explicit `<start_date>` / `<end_date>` literals or parameters to keep SQL portable across providers.

Databricks SQL week-bounds template:

```sql
with bounds as (
  select
    date_sub(next_day(current_date(), 'Sun'), 14) as wk_start,
    date_sub(next_day(current_date(), 'Sun'), 8)  as wk_end
)
select *
from bounds;
```

BigQuery SQL week-bounds template:

```sql
with bounds as (
  select
    date_sub(date_trunc(current_date(), week(sunday)), interval 7 day) as wk_start,
    date_sub(date_trunc(current_date(), week(sunday)), interval 1 day) as wk_end
)
select *
from bounds;
```

## Filter-value validation query (required for geo/segment)

Use the actual candidate geo column from `get_columns`:

```sql
select
  <geo_col>,
  count(*) as rows
from <relation>
where <time_col> between <start_date> and <end_date>
group by 1
order by rows desc
limit 50;
```

For UK requests, do not assume mapping. Validate values and choose the matching value(s) present in data.

## Sessions + CR query pattern

Use this pattern when both a volume metric and a rate metric are requested:

```sql
with scoped as (
  select *
  from <relation>
  where date(<time_col>) between date(<start_date>) and date(<end_date>)
    and <geo_col> in (<validated_geo_values>)
),
agg as (
  select
    <sessions_expr> as sessions,
    <cr_num_expr>   as cr_num,
    <cr_den_expr>   as cr_den
  from scoped
)
select
  sessions,
  case when cr_den = 0 then null else cr_num / cr_den end as conversion_rate
from agg;
```

If a canonical conversion-rate expression exists in metadata, use it instead of rebuilding numerator/denominator.

## Publishing workflow

When publishing results to Google Sheets:
1. Create the sheet first with `sheets_create`
2. Add header row with `sheets_append` (comma-separated column names)
3. Add data rows one at a time with `sheets_append`
4. Include the spreadsheet URL in the response
5. If emailing, use `gmail_send` with the sheet link
