---
name: contacts-directory
description: "Search and manage Google Contacts and company directory. Use for finding people, managing contact information, and directory lookups."
allowed-tools: "mcp__google-people__list_contacts mcp__google-people__search_contacts mcp__google-people__get_contact mcp__google-people__create_contact mcp__google-people__update_contact mcp__google-people__delete_contact mcp__google-people__list_contact_groups mcp__google-people__search_directory mcp__google-people__list_directory mcp__google-people__batch_get mcp__google-people__create_contact_group mcp__google-people__delete_contact_group mcp__google-people__modify_group_members mcp__google-people__list_other_contacts mcp__google-people__schema mcp__google-people__run_api_call"
metadata:
  owner: "cowork"
  persona: "assistant"
  version: "1.0.0"
---

# Contacts & Directory Skill

## Mission

Help users find people, look up contact details, and manage their Google Contacts.

## Workflow

### 1. Search for contacts
- Use `search_contacts` with a name, email, or phone number query
- Use `list_contacts` to browse all contacts (paginated)
- Use `list_contact_groups` to see contact groups (labels)

### 2. View contact details
- Use `get_contact` with a resource name to see full details
- Contact resource names follow the format `people/{personId}`

### 3. Create or update contacts
- Use `create_contact` with name, email, phone, and organization fields
- Use `update_contact` to modify existing contact information
- Always include a `personFields` mask specifying which fields to read/write

### 4. Advanced operations
- Call `schema` to look up request/response formats for People API methods
- Use `run_api_call` for directory lookups, other contacts, or batch operations

## Common contact fields

| Field | Description |
|---|---|
| `names` | Display name, given name, family name |
| `emailAddresses` | Email addresses with type (home, work) |
| `phoneNumbers` | Phone numbers with type |
| `organizations` | Company, title, department |
| `addresses` | Physical addresses |
| `birthdays` | Date of birth |
| `urls` | Websites and social profiles |
| `biographies` | Notes about the contact |

## Search tips

- Search is fuzzy — "Jon" will match "John", "Jonathan", etc.
- Search across name, email, and phone fields simultaneously
- For directory lookups (coworkers), use `run_api_call` with the directory source
- Use `list_contact_groups` to find contacts organized by label

## Tool reference

| Tool | When to use |
|---|---|
| `list_contacts` | Browse all contacts (paginated) |
| `search_contacts` | Find contacts by name, email, or phone |
| `get_contact` | Get full details for a specific person |
| `create_contact` | Add a new contact |
| `update_contact` | Edit an existing contact's information |
| `delete_contact` | Remove a contact |
| `list_contact_groups` | See contact groups/labels |
| `schema` | Look up API formats for advanced operations |
| `run_api_call` | Execute arbitrary People API calls |

## Important rules

1. **Search before creating** — check if the contact already exists to avoid duplicates
2. **Confirm before deleting** — always verify with the user before removing a contact
3. **Respect privacy** — don't expose contact details unnecessarily; only show what was asked for
4. **Include context when creating** — add organization, title, and notes so the contact is useful later
