---
name: gmail-management
description: "Manage Gmail: send, triage inbox, search messages, read threads, and organize labels. Use when the user wants to send emails, check inbox, find messages, reply to threads, or manage their email."
allowed-tools: "mcp__google-gmail__send mcp__google-gmail__read mcp__google-gmail__triage mcp__google-gmail__list_messages mcp__google-gmail__search mcp__google-gmail__get_message mcp__google-gmail__list_labels mcp__google-gmail__list_threads mcp__google-gmail__get_profile mcp__google-gmail__modify mcp__google-gmail__trash mcp__google-gmail__untrash mcp__google-gmail__list_drafts mcp__google-gmail__run_api_call mcp__google-gmail__schema mcp__google-gmail__create_draft mcp__google-gmail__get_draft mcp__google-gmail__send_draft mcp__google-gmail__delete_draft mcp__google-gmail__get_thread mcp__google-gmail__trash_thread mcp__google-gmail__create_label mcp__google-gmail__delete_label mcp__google-gmail__get_vacation mcp__google-gmail__set_vacation mcp__google-gmail__list_filters mcp__google-gmail__create_filter"
metadata:
  owner: "cowork"
  persona: "assistant"
  version: "1.0.0"
---

# Gmail Management Skill

## Mission

Help users manage their email efficiently: triage inbox, find important messages, compose and send emails, reply to threads, forward information, and organize messages.

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
3. To reply to a message, use `send` with subject prefixed "Re: ..." and quote the relevant parts of the original message in the body
4. To forward a message, use `send` with subject prefixed "Fwd: ..." and include the original message content in the body with forwarding context

### Managing messages
- Use `modify` to add/remove labels on messages
- Use `trash` to move a message to trash; use `untrash` to restore it
- Use `list_drafts` to view saved drafts

### Email etiquette
- When replying, quote the relevant parts of the original message for context
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
| `send` | Compose and send new email (also used for replies and forwards) |
| `modify` | Add or remove labels on a message |
| `trash` | Move a message to trash |
| `untrash` | Restore a message from trash |
| `list_drafts` | View saved drafts |
| `list_labels` | See available labels/folders |
| `get_profile` | Get user's email address and stats |
| `create_draft` | Create a new email draft |
| `get_draft` | Get draft content by ID |
| `send_draft` | Send an existing draft |
| `delete_draft` | Delete a draft permanently |
| `get_thread` | Get full thread with all messages |
| `trash_thread` | Move an entire thread to trash |
| `create_label` | Create a custom label |
| `delete_label` | Delete a label |
| `get_vacation` | Get vacation responder settings |
| `set_vacation` | Enable/disable vacation responder |
| `list_filters` | List email filters |
| `create_filter` | Create an email filter rule |
| `run_api_call` | Execute advanced Gmail API calls |
| `schema` | API reference for advanced operations |
