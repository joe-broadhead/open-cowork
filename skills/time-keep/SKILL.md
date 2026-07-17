---
name: time-keep
description: Use the time-keep MCP for reliable time context - IANA timezone ops, date arithmetic, calendar queries, business days, offline holiday lookups (2000-2030), and local timers.
---

# time-keep

Open Cowork’s **only** agent time engine. Backed by the bundled
[time-keep](https://github.com/joe-broadhead/time-keep) native MCP (stdio).

**Always call the real tools** (function calling). OpenCode exposes them as
`time-keep_<tool>` — for example `time-keep_current_time`. Prefer these over
shell `date`, `bash`, or inventing times from model memory.

If you do not see `time-keep_*` tools (for example `time-keep_current_time`)
in your tool list, say so briefly and stop — do **not** invent CLI fallbacks
or pretend to call MCP. The desktop app should list time-keep when the
bundled MCP is connected (status bar MCP count).

## Tool Map

All tools are exposed as `time-keep_<tool>` (OpenCode MCP naming):

| Need | Tool id |
|------|---------|
| Current time | `time-keep_current_time` |
| List timezones | `time-keep_list_timezones` |
| Timezone details + DST | `time-keep_timezone_info` |
| Convert between timezones | `time-keep_convert_timezone` |
| Calendar fields (weekday, ISO week, etc.) | `time-keep_calendar_query` |
| Date add/subtract | `time-keep_date_arithmetic` |
| Date difference | `time-keep_date_diff` |
| Parse/format dates | `time-keep_date_format` |
| Holiday check or list | `time-keep_holidays` |
| Business day counts | `time-keep_business_days` |
| Set a timer | `time-keep_timer_set` |
| Read a timer | `time-keep_timer_get` |
| List timers by tag | `time-keep_timer_list` |
| Delete a timer | `time-keep_timer_delete` |
| Check overdue timers | `time-keep_timer_check` |

## Guardrails

- Default timezone is **UTC** — always be explicit when it matters.
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
- **CLI transport**: last-resort only if MCP tools are missing.
  See [references/cli.md](references/cli.md).
- **Output contracts**: JSON (default), table, CSV, and error envelopes.
  See [references/output-contracts.md](references/output-contracts.md).
