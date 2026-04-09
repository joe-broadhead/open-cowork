---
name: appscript-automation
description: "Create, deploy, and run Google Apps Script projects. Use when the user wants to automate Google Workspace workflows, build custom functions for Sheets, create web apps, set up triggers, or extend Docs/Sheets/Slides/Forms with scripts."
allowed-tools: "mcp__google-appscript__create_project mcp__google-appscript__get_project mcp__google-appscript__get_content mcp__google-appscript__update_content mcp__google-appscript__get_metrics mcp__google-appscript__run mcp__google-appscript__list_deployments mcp__google-appscript__create_deployment mcp__google-appscript__update_deployment mcp__google-appscript__delete_deployment mcp__google-appscript__create_version mcp__google-appscript__list_versions mcp__google-appscript__list_processes mcp__google-appscript__list_script_processes mcp__google-appscript__schema"
metadata:
  owner: "cowork"
  persona: "developer"
  version: "1.0.0"
---

# Apps Script Automation Skill

## Mission

Create and manage Google Apps Script projects to automate Google Workspace workflows. Build custom functions, web apps, triggers, and integrations.

## Key concepts

### Script types
- **Standalone**: Independent project, not bound to any file
- **Bound**: Attached to a Sheet, Doc, Slide, or Form via `parentId`
- **Bound scripts** can access the parent file directly (e.g. `SpreadsheetApp.getActiveSpreadsheet()`)

### File types in a project
- `SERVER_JS` (.gs) — Server-side JavaScript (Google Apps Script runtime)
- `HTML` (.html) — HTML templates for web apps and dialogs
- `JSON` (appsscript.json) — Project manifest with scopes, timezone, runtime version

### The manifest (appsscript.json)
Every project must have a manifest. Minimal example:
```json
{
  "timeZone": "Europe/London",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8"
}
```

Add OAuth scopes when accessing APIs:
```json
{
  "timeZone": "Europe/London",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/gmail.send"
  ],
  "runtimeVersion": "V8"
}
```

## Workflow

### 1. Create a project
- **Standalone**: `create_project(title: "My Automation")`
- **Bound to Sheet**: `create_project(title: "Sheet Script", parentId: "SHEET_ID")`

### 2. Write the code
Use `update_content` with the complete file set. Always include the manifest.

Example — custom Sheet function:
```javascript
// File: Code (type: SERVER_JS)
function MULTIPLY_TABLE(size) {
  const result = [];
  for (let i = 1; i <= size; i++) {
    const row = [];
    for (let j = 1; j <= size; j++) {
      row.push(i * j);
    }
    result.push(row);
  }
  return result;
}
```

Example — email automation:
```javascript
// File: Code (type: SERVER_JS)
function sendDailyReport() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = sheet.getDataRange().getValues();
  const htmlBody = '<h2>Daily Report</h2><table>' +
    data.map(row => '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('') +
    '</table>';
  GmailApp.sendEmail('team@company.com', 'Daily Report', '', { htmlBody });
}
```

### 3. Create a version
- Use `create_version` to snapshot the current code as an immutable version
- Versions are required for API executable deployments

### 4. Deploy
- **API Executable**: `create_deployment` — allows calling functions via the `run` tool
- **Web App**: Requires manual setup in the Apps Script editor (can't be done via API alone)
- **Triggers**: Set up in the manifest or via the Apps Script editor

### 5. Execute
- Use `run` to call a function in a deployed project
- Pass parameters as an array
- Use `devMode: true` to test against saved (not deployed) code

### 6. Monitor
- Use `list_processes` to see recent executions
- Use `list_script_processes` for a specific project
- Use `get_metrics` for usage statistics

## Tool reference

| Tool | When to use |
|---|---|
| `create_project` | Start a new script (standalone or bound) |
| `get_project` | Get project metadata |
| `get_content` | Read all source files |
| `update_content` | Write/replace all source files |
| `get_metrics` | Usage stats (executions, errors, users) |
| `run` | Execute a function in a deployed project |
| `list_deployments` | See all deployments |
| `create_deployment` | Deploy for API execution |
| `update_deployment` | Change deployment version |
| `delete_deployment` | Remove a deployment |
| `create_version` | Snapshot current code as immutable version |
| `list_versions` | See all versions |
| `list_processes` | Recent executions (all scripts) |
| `list_script_processes` | Recent executions (specific script) |
| `schema` | API reference for data structures |

## Common patterns

### Custom Sheet function
1. Create bound project with Sheet as parent
2. Write a function that returns a 2D array
3. User calls it as `=MY_FUNCTION()` in the sheet

### Scheduled automation
1. Create the script with the function to run
2. Add a time-driven trigger in the manifest or editor
3. The function runs automatically on schedule

### Data pipeline
1. Read from one source (Sheet, API, etc.)
2. Transform the data
3. Write to another destination (Sheet, email, etc.)
4. Deploy and schedule

## Important rules

1. **`update_content` replaces ALL files** — always include every file including the manifest
2. **Read before updating** — use `get_content` first to see existing files
3. **Version before deploying** — create a version, then deploy that version
4. **OAuth scopes** — add required scopes to the manifest or execution will fail
5. **V8 runtime** — always use `"runtimeVersion": "V8"` in the manifest
