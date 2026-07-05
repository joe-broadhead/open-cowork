# Calendar & Dates

Tool: `calendar_query`, `convert_timezone`, `date_arithmetic`, `date_diff`, `date_format`, `holidays`, `business_days`

## Resolve relative dates first

Always convert "today", "tomorrow", "next Friday" to absolute ISO dates before calling tools.

## Timezone

```json
// timezone_info
{ "timezone": "Europe/London" }
// Returns: current time, DST status, UTC offset, next DST transition

// convert_timezone
{ "datetime": "2026-06-21T12:00:00Z", "from_timezone": "UTC", "to_timezone": "Asia/Tokyo" }
```

## Date operations

```json
// date_arithmetic — add 1 month to Jan 31
{ "date": "2026-01-31", "operation": "add", "amount": 1, "unit": "months" }
// Returns: "2026-02-28" (month-end clamped)

// date_diff — days between dates
{ "from": "2026-06-01", "to": "2026-06-21" }
// Returns: signed_days: 20, signed_weeks: 2

// date_format — parse and reformat
{ "input": "2026-06-21T12:00:00Z", "output_format": "rfc2822" }
// Returns: "Sun, 21 Jun 2026 12:00:00 +0000"

// calendar_query — day-of-week, ISO week, quarter, leap year
{ "date": "2026-06-21" }
```

## Holidays

Coverage: offline 2000–2030. Always mention this bound.

```json
// holidays check
{ "action": "check", "country": "GB", "date": "2026-12-25" }
// Returns: is_holiday: true, name: "Christmas Day"

// holidays list
{ "action": "list", "country": "GB", "year": 2026 }
```

## Business days

```json
// biz days between — with holiday skipping
{ "action": "between", "from": "2026-12-24", "to": "2026-12-28", "country": "GB", "skip_holidays": true }
// Returns: business_days count, holidays_skipped array
```

## Guardrails

- Never use bare city names as timezones.
- Never assume holiday data beyond 2000–2030.
- DST ambiguity: report ambiguous/nonexistent local datetimes as invalid, don't guess.
- Prefer JSON for evidence; use table/CSV only when user asks.
