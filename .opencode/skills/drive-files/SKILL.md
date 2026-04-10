---
name: drive-files
description: "Manage Google Drive: search files, share, export, manage permissions, comments. Use when the user wants to find files, share documents, manage access, export to PDF, or organize their Drive."
allowed-tools: "mcp__google-drive__list_files mcp__google-drive__get_file mcp__google-drive__create_file mcp__google-drive__copy_file mcp__google-drive__update_file mcp__google-drive__delete_file mcp__google-drive__export_file mcp__google-drive__list_permissions mcp__google-drive__get_permission mcp__google-drive__update_permission mcp__google-drive__delete_permission mcp__google-drive__share_file mcp__google-drive__list_comments mcp__google-drive__add_comment mcp__google-drive__update_comment mcp__google-drive__delete_comment mcp__google-drive__about mcp__google-drive__create_folder mcp__google-drive__move_file mcp__google-drive__list_revisions mcp__google-drive__empty_trash mcp__google-drive__schema mcp__google-drive__run_api_call"
metadata:
  owner: "cowork"
  persona: "assistant"
  version: "1.0.0"
---

# Drive File Management Skill

## Mission

Help users find, organize, share, and manage files in Google Drive.

## Workflow

### Finding files
Use `list_files` with Drive search query syntax:
- `name contains 'report'` — name search
- `mimeType = 'application/vnd.google-apps.spreadsheet'` — Sheets only
- `mimeType = 'application/vnd.google-apps.document'` — Docs only
- `mimeType = 'application/vnd.google-apps.presentation'` — Slides only
- `'me' in owners` — files I own
- `sharedWithMe` — shared with me
- `trashed = false` — not in trash
- `modifiedTime > '2026-04-01'` — recently modified
- Combine with `and`: `name contains 'Q4' and mimeType = 'application/vnd.google-apps.spreadsheet'`

### Sharing files
1. Use `list_permissions` to see current access
2. Use `share_file` to grant access:
   - `role`: `reader`, `commenter`, `writer`, `organizer`
   - `type`: `user`, `group`, `domain`, `anyone`
   - For users: include `emailAddress`

### Exporting files
Use `export_file` to convert Google Workspace files:
- Sheets → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx)
- Docs → `application/pdf` or `text/plain`
- Slides → `application/pdf`

### Commenting
- Use `list_comments` to see discussion on a file
- Use `add_comment` to leave feedback

## Tool reference

| Tool | When to use |
|---|---|
| `list_files` | Search and browse files |
| `get_file` | Get file metadata (name, size, owners, modified) |
| `create_file` | Create a new file/folder |
| `copy_file` | Duplicate a file |
| `update_file` | Rename or move a file |
| `delete_file` | Permanently delete (use with caution) |
| `export_file` | Export Google files to PDF/xlsx/etc. |
| `list_permissions` | See who has access |
| `share_file` | Grant access to users/groups |
| `list_comments` | Read comments on a file |
| `add_comment` | Add a comment to a file |
| `schema` | API reference for advanced operations |

## Important rules

1. **Confirm before deleting** — deletions are permanent
2. **Check existing permissions** before sharing
3. **Use the correct mimeType** when searching for specific file types
