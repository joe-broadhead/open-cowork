---
name: chat-messaging
description: "Send and manage messages in Google Chat spaces. Use for sending messages, managing spaces, viewing conversations, and managing space members."
allowed-tools: "mcp__google-chat__list_spaces mcp__google-chat__get_space mcp__google-chat__create_space mcp__google-chat__create_message mcp__google-chat__list_messages mcp__google-chat__get_message mcp__google-chat__update_message mcp__google-chat__delete_message mcp__google-chat__list_members mcp__google-chat__schema mcp__google-chat__run_api_call mcp__google-chat__find_dm mcp__google-chat__update_space mcp__google-chat__add_member mcp__google-chat__remove_member mcp__google-chat__get_member mcp__google-chat__create_reaction mcp__google-chat__delete_reaction"
metadata:
  owner: "cowork"
  persona: "assistant"
  version: "1.0.0"
---

# Chat Messaging Skill

## Mission

Help users communicate via Google Chat — send messages, read conversations, manage spaces, and organize memberships.

## Workflow

### 1. Find the right space
- Use `list_spaces` to see all spaces the user belongs to
- Use `get_space` with a space name/ID for details on a specific space
- Use `find_dm` to locate an existing direct message with a specific user
- Space names follow the format `spaces/{spaceId}`

### 2. Send or read messages
- **Send a message**: Use `create_message` with the space name and message text
- **Read recent messages**: Use `list_messages` on a space to see the conversation
- **Get a specific message**: Use `get_message` with the full message resource name

### 3. Update or delete messages
- Use `update_message` to edit a sent message (only your own messages)
- Use `delete_message` to remove a message

### 4. Manage spaces and members
- Use `create_space` to set up a new space for a team or topic
- Use `update_space` to change a space's display name or description
- Use `list_members` to see who is in a space
- Use `get_member` to get details about a specific member
- Use `add_member` to add someone to a space
- Use `remove_member` to remove someone from a space

### 5. Reactions
- Use `create_reaction` to react to a message with an emoji
- Use `delete_reaction` to remove a reaction

### 6. Advanced operations
- Call `schema` to look up request/response formats for any Chat API method
- Use `run_api_call` for operations not covered by the named tools

## Tool reference

| Tool | When to use |
|---|---|
| `list_spaces` | Browse all spaces the user belongs to |
| `get_space` | Get details on a specific space |
| `create_space` | Create a new chat space |
| `create_message` | Send a message to a space |
| `list_messages` | Read recent messages in a space |
| `get_message` | Get a specific message by resource name |
| `update_message` | Edit a previously sent message |
| `delete_message` | Remove a message |
| `list_members` | List members of a space |
| `find_dm` | Find a direct message space with a specific user |
| `update_space` | Update space display name or description |
| `add_member` | Add a member to a space |
| `remove_member` | Remove a member from a space |
| `get_member` | Get details about a specific member |
| `create_reaction` | React to a message with an emoji |
| `delete_reaction` | Remove a reaction from a message |
| `schema` | Look up API formats for advanced operations |
| `run_api_call` | Execute arbitrary Chat API calls |

## Message formatting tips

- Google Chat supports basic formatting: `*bold*`, `_italic_`, `` `code` ``, ` ```code block``` `
- Use Cards v2 JSON via `run_api_call` for rich messages with buttons and sections
- Keep messages concise — avoid walls of text in chat

## Important rules

1. **Confirm before sending** — always show the user what will be sent before calling `create_message`
2. **Respect space context** — read recent messages to understand the conversation before replying
3. **Don't spam** — never send multiple messages in rapid succession
4. **Use descriptive space names** — when creating spaces, use clear, meaningful display names
