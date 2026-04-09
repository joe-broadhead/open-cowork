---
name: calendar-scheduling
description: "Manage Google Calendar: create events, check availability, schedule meetings, quick-add from natural language, list calendars. Use when the user wants to schedule, check their calendar, find free time, or manage events."
allowed-tools: "mcp__google-calendar__list_events mcp__google-calendar__get_event mcp__google-calendar__create_event mcp__google-calendar__quick_add mcp__google-calendar__update_event mcp__google-calendar__delete_event mcp__google-calendar__list_calendars mcp__google-calendar__freebusy mcp__google-calendar__schema"
metadata:
  owner: "cowork"
  persona: "assistant"
  version: "1.0.0"
---

# Calendar Scheduling Skill

## Mission

Help users manage their calendar: schedule meetings, check availability, create events, and organize their time.

## Workflow

### Checking the calendar
1. Use `list_events` with `timeMin` (ISO format) to see upcoming events
2. Default to `singleEvents: true` and `orderBy: startTime` for a clean timeline

### Scheduling a meeting
1. **Check availability first**: Use `freebusy` to check if the time slot is free
2. **Create the event**: Use `create_event` with summary, start/end times, and attendees
3. **Confirm**: Show the user what was created

### Quick scheduling
- Use `quick_add` for natural language: "Meeting with Alice tomorrow at 3pm for 1 hour"
- The API parses the text into a proper event

### Time format
- Always use ISO 8601 with timezone: `2026-04-10T15:00:00+01:00`
- For all-day events use date format: `2026-04-10`
- When the user doesn't specify a timezone, ask or use their profile timezone

### Updating events
- Use `update_event` to change title, time, description, or attendees
- Only include fields that need to change

## Tool reference

| Tool | When to use |
|---|---|
| `list_events` | See upcoming events |
| `get_event` | Get full event details |
| `create_event` | Schedule a new event with details |
| `quick_add` | Create event from natural language text |
| `update_event` | Change an existing event |
| `delete_event` | Cancel/remove an event |
| `list_calendars` | See all calendars the user has |
| `freebusy` | **Check availability before scheduling** |
| `schema` | API reference for advanced operations |

## Important rules

1. **Always check freebusy** before creating events during work hours
2. **Confirm with the user** before creating or deleting events
3. **Include timezone** in all datetime values
4. **Add descriptions** with context when scheduling on behalf of the user
