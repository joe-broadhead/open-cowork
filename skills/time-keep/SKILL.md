---
name: time-keep
description: Use the time-keep MCP for reliable time context - IANA timezone ops, date arithmetic, calendar queries, business days, offline holiday lookups (2000-2030), and local timers.
---

# time-keep

Local-first MCP tools for deterministic time, calendar, and timer work. When
the time-keep MCP is available, prefer it over the built-in clock tools for
business days, holidays, timezone catalogs, date formatting, and timers — it
is the deeper time engine; the built-in clock covers only the basics.

**Prefer `mcp__time-keep__*` tools over shell `time-keep` / `bash`.** Only fall
back to the CLI when MCP tools are unavailable (see references/cli.md).

## Tool Map

All MCP tools are exposed as `mcp__time-keep__<tool>`:

| Need | Tool |
|------|------|
| Current time | `current_time` |
| List timezones | `list_timezones` |
| Timezone details + DST | `timezone_info` |
| Convert between timezones | `convert_timezone` |
| Calendar fields (weekday, ISO week, etc.) | `calendar_query` |
| Date add/subtract | `date_arithmetic` |
| Date difference | `date_diff` |
| Parse/format dates | `date_format` |
| Holiday check or list | `holidays` |
| Business day counts | `business_days` |
| Set a timer | `timer_set` |
| Read a timer | `timer_get` |
| List timers by tag | `timer_list` |
| Delete a timer | `timer_delete` |
| Check overdue timers | `timer_check` |

## Guardrails

- Default timezone is **UTC** — always be explicit.
- Holiday data is offline, bounded to **2000–2030**. Mention this when used.
- Timers persist in local SQLite; setting or deleting a timer asks for the
  user's approval by design.
- Use IANA timezone names. Do not silently accept bare city names.
- Do not hide DST ambiguity — report ambiguous local datetimes as invalid.
- MCP tool failures surface as `isError: true` — inspect the JSON error
  before retrying.

## Output Standard

Include: tool used, input date, resolved timezone, date range, whether
holiday data was used, and any error details.

## Sub-topics

- **Calendar & dates**: `calendar_query`, `convert_timezone`,
  `date_arithmetic`, `date_diff`, `date_format`, `holidays`,
  `business_days`. See [references/calendar.md](references/calendar.md).
- **Timers**: `timer_set`, `timer_get`, `timer_list`, `timer_check`,
  `timer_delete`. See [references/timers.md](references/timers.md).
- **CLI transport**: when MCP is unavailable, use the `time-keep` binary
  directly. See [references/cli.md](references/cli.md).
- **Output contracts**: JSON (default), table, CSV, and error envelopes.
  See [references/output-contracts.md](references/output-contracts.md).
