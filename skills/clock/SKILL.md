---
name: clock
description: Use the clock MCP for current time, timezone conversion, date ranges, durations, and relative calendar math.
---

# Clock

Use this skill whenever an answer depends on the current date, current time,
relative date language, timezones, schedules, deadlines, durations, or calendar
boundaries.

## Core Rule

When the clock MCP is available, call the relevant `mcp__clock__*` tool before doing
date or time calculations. Do not rely on model memory for "today", "now",
"last week", "next month", timezones, offsets, or elapsed time.

**Do not use `bash`/`date` or shell CLIs for time** when `mcp__clock__*` or
`mcp__time-keep__*` tools are available. MCP tools are authoritative and avoid
permission prompts.

When the deeper `time-keep` MCP is also available, prefer its
`mcp__time-keep__*` tools for anything beyond the basics: business-day
counts, holiday lookups, timezone catalogs and DST detail, date formatting,
and timers. The built-in clock stays the zero-install fallback.

If the user asked for time-keep but `mcp__time-keep__*` tools are missing,
**use `mcp__clock__*` immediately** for current time, ranges, conversions,
and durations. Do not fall back to shell unless clock tools are also absent.

## Tool Choice

- `mcp__clock__current_time`: get the authoritative current time for a timezone.
- `mcp__clock__convert_time`: convert an instant or source-local datetime between
  timezones.
- `mcp__clock__date_math`: add or subtract calendar and clock units.
- `mcp__clock__date_range`: resolve today, yesterday, this week, last month, rolling
  N days, and similar calendar windows.
- `mcp__clock__duration_between`: compute elapsed time between two dates or times.

## Guardrails

- Always state final answers with concrete absolute dates when the user uses
  relative terms like "today", "tomorrow", "yesterday", or "last week".
- Include the timezone when it affects the answer.
- Ask for the timezone if the user's local timezone is unclear and the result
  depends on it.
- Weekly ranges default to Sunday-start weeks. Pass `week_starts_on: "monday"`
  only when the user, locale, or workflow explicitly needs Monday-start weeks.
- Do not invent holiday, business-day, or regional calendar rules. The clock
  tool does not provide them in v1.
