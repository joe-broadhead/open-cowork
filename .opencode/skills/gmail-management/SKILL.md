---
name: gmail-management
description: "Manage Gmail: send, reply, forward, triage inbox, search messages, read threads, and organize labels. Use when the user wants to send emails, check inbox, find messages, reply to threads, or manage their email."
allowed-tools: "mcp__google-gmail__send mcp__google-gmail__reply mcp__google-gmail__reply_all mcp__google-gmail__forward mcp__google-gmail__read mcp__google-gmail__triage mcp__google-gmail__list_messages mcp__google-gmail__search mcp__google-gmail__get_message mcp__google-gmail__list_labels mcp__google-gmail__list_threads mcp__google-gmail__get_profile mcp__google-gmail__schema"
metadata:
  owner: "cowork"
  persona: "assistant"
  version: "1.0.0"
---

# Gmail Management Skill

## Mission

Help users manage their email efficiently: triage inbox, find important messages, compose and send emails, reply to threads, and forward information.

## Workflow

### Checking inbox
1. Use `triage` to get an unread inbox summary (sender, subject, date)
2. Use `read` with a message ID to see the full body of a specific message
3. Use `list_threads` to see conversation threads

### Finding messages
- Use `search` with Gmail query syntax:
  - `from:alice` — messages from alice
  - `subject:report` — subject contains "report"
  - `after:2026/04/01` — after a date
  - `has:attachment` — has attachments
  - `is:unread` — unread messages
  - `in:sent` — sent messages
  - `label:important` — labeled important
  - Combine: `from:alice subject:report after:2026/04/01`

### Sending email
1. **Always confirm** the recipient, subject, and body before sending
2. Use `send` for new emails
3. Use `reply` or `reply_all` for thread replies (maintains threading)
4. Use `forward` to share a message with someone else

### Email etiquette
- Reply to the sender only with `reply`; use `reply_all` only when all recipients need to see the response
- Keep subject lines concise and descriptive
- When forwarding, add context about why the message is being forwarded

## Tool reference

| Tool | When to use |
|---|---|
| `triage` | Quick inbox overview — start here |
| `read` | Read full message body |
| `search` | Find messages with Gmail query syntax |
| `list_messages` | List recent messages (with optional query) |
| `get_message` | Get full message metadata and body |
| `list_threads` | View conversation threads |
| `send` | Compose and send new email |
| `reply` | Reply to a specific message |
| `reply_all` | Reply to all recipients |
| `forward` | Forward a message to someone |
| `list_labels` | See available labels/folders |
| `get_profile` | Get user's email address and stats |
| `schema` | API reference for advanced operations |
