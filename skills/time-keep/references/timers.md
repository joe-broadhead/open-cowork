# Timers

Tools: `timer_set`, `timer_get`, `timer_list`, `timer_check`, `timer_delete`

## Data directory

- **User's real timers**: default path `~/.local/share/time-keep/timers.db`
- **Tests/examples**: use `TIME_KEEP_DATA_DIR="$(mktemp -d)"` via CLI to isolate state

## Usage

```json
// timer_set — create a reminder
{ "name": "deploy-window", "deadline": "2026-07-01T17:00:00-04:00", "tags": ["ops", "release"] }

// timer_get — read one timer
{ "name": "deploy-window" }

// timer_list — filter by tag
{ "tag": "ops" }

// timer_check — list overdue timers
// no params needed

// timer_delete — clean up
{ "name": "deploy-window" }
```

## Storage

- SQLite WAL at `~/.local/share/time-keep/timers.db`
- Private file permissions where supported
- Local-only — no cloud sync, no multi-user

## Guardrails

- Deadlines must be absolute ISO/RFC3339. No "tomorrow".
- Never mutate the default timer database during validation or examples.
- Timer names, descriptions, deadlines, and tags are private local data.
