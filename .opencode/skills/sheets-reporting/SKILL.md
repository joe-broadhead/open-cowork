---
name: sheets-reporting
description: "Create, format, and populate Google Sheets spreadsheets. Use when the user wants to build reports, dashboards, data tables, charts, or export data to Sheets. Handles creation, data writing, formatting, multi-sheet workbooks, and sharing."
allowed-tools: "mcp__google-sheets__create mcp__google-sheets__get mcp__google-sheets__read mcp__google-sheets__write mcp__google-sheets__append mcp__google-sheets__clear mcp__google-sheets__batch_read mcp__google-sheets__batch_write mcp__google-sheets__batch_clear mcp__google-sheets__batch_update mcp__google-sheets__add_sheet mcp__google-sheets__delete_sheet mcp__google-sheets__rename_sheet mcp__google-sheets__format_cells mcp__google-sheets__auto_resize mcp__google-sheets__copy_sheet mcp__google-sheets__quick_append mcp__google-sheets__quick_read mcp__google-sheets__schema mcp__google-sheets__run_api_call"
metadata:
  owner: "cowork"
  persona: "analyst"
  version: "1.0.0"
---

# Sheets Reporting Skill

## Mission

Build professional, well-formatted Google Sheets reports from data. Handle everything from simple data exports to multi-tab dashboards with formatting, headers, and computed fields.

## Workflow

### 1. Create the spreadsheet
- Use `create` with a descriptive title including the date/period
- Extract the `spreadsheetId` from the response

### 2. Write data
- Use `write` for structured data with headers (preferred — writes to exact range)
- Use `append` for adding rows incrementally
- Use `batch_write` when populating multiple ranges/tabs at once
- Always include a header row as the first row

### 3. Format the spreadsheet
- **Bold headers**: Use `format_cells` on row 0 with `bold: true`
- **Header background**: Use `format_cells` with `bgColor` (e.g. `{red:0.2, green:0.2, blue:0.3}` for dark headers)
- **Number formatting**: Use `format_cells` with `numberFormat` for percentages, currency, etc.
- **Auto-resize columns**: Use `auto_resize` after writing data
- **Alignment**: Right-align numbers, left-align text

### 4. Multi-tab workbooks
- Use `add_sheet` to create additional tabs
- Write data to each tab using the tab name in the range (e.g. `"Summary!A1"`)

### 5. Advanced formatting (charts, conditional formatting, etc.)
- **Always call `schema` first** before using `batch_update` to look up the correct request format
- Call `schema()` with no args to list all 69 available request types
- Call `schema(request_type: "addChart")` to get the full structure for a specific request type
- Never guess at `batch_update` request params — the schema tool pulls the live API definition

### 6. Share the result
- Include the spreadsheet URL in the response: `https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit`

## Tool reference

| Tool | When to use |
|---|---|
| `create` | Start a new spreadsheet |
| `get` | Check structure, sheet names, or properties |
| `read` / `quick_read` | Read existing data from a range |
| `batch_read` | Read multiple ranges in one call |
| `write` | Write structured data to a specific range |
| `append` / `quick_append` | Add rows to the end of a table |
| `batch_write` | Write to multiple ranges at once |
| `clear` | Clear data from a range (keeps formatting) |
| `schema` | **Call before batch_update** — returns exact JSON templates for any request type |
| `batch_update` | Advanced: charts, conditional formatting, merges, filters, borders, sorting, validation |
| `add_sheet` | Add a new tab to the workbook |
| `format_cells` | Bold, colors, alignment, number format |
| `auto_resize` | Fit column widths to content |
| `copy_sheet` | Copy a tab to another spreadsheet |

## Formatting best practices

### Headers
```json
{"bold": true, "bgColor": {"red": 0.15, "green": 0.15, "blue": 0.2}, "textColor": {"red": 0.9, "green": 0.9, "blue": 0.9}}
```

### Percentages
```json
{"numberFormat": {"type": "PERCENT", "pattern": "0.00%"}}
```

### Currency
```json
{"numberFormat": {"type": "CURRENCY", "pattern": "#,##0.00"}}
```

### Large numbers
```json
{"numberFormat": {"type": "NUMBER", "pattern": "#,##0"}}
```

## batch_update recipes

### Add a chart
```json
{
  "addChart": {
    "chart": {
      "spec": {
        "title": "Sales by Region",
        "basicChart": {
          "chartType": "BAR",
          "legendPosition": "BOTTOM_LEGEND",
          "axis": [
            {"position": "BOTTOM_AXIS", "title": "Region"},
            {"position": "LEFT_AXIS", "title": "Sales"}
          ],
          "domains": [{"domain": {"sourceRange": {"sources": [{"sheetId": 0, "startRowIndex": 0, "endRowIndex": 10, "startColumnIndex": 0, "endColumnIndex": 1}]}}}],
          "series": [{"series": {"sourceRange": {"sources": [{"sheetId": 0, "startRowIndex": 0, "endRowIndex": 10, "startColumnIndex": 1, "endColumnIndex": 2}]}}}]
        }
      },
      "position": {"overlayPosition": {"anchorCell": {"sheetId": 0, "rowIndex": 0, "columnIndex": 3}}}
    }
  }
}
```

### Freeze header row
```json
{"updateSheetProperties": {"properties": {"sheetId": 0, "gridProperties": {"frozenRowCount": 1}}, "fields": "gridProperties.frozenRowCount"}}
```

### Add conditional formatting (color scale)
```json
{
  "addConditionalFormatRule": {
    "rule": {
      "ranges": [{"sheetId": 0, "startRowIndex": 1, "endRowIndex": 100, "startColumnIndex": 1, "endColumnIndex": 2}],
      "gradientRule": {
        "minpoint": {"color": {"red": 0.8, "green": 0.2, "blue": 0.2}, "type": "MIN"},
        "maxpoint": {"color": {"red": 0.2, "green": 0.8, "blue": 0.2}, "type": "MAX"}
      }
    },
    "index": 0
  }
}
```

### Merge cells
```json
{"mergeCells": {"range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 0, "endColumnIndex": 3}, "mergeType": "MERGE_ALL"}}
```

## Output

Always return:
- The spreadsheet URL
- A summary of what was created (tabs, row counts, formatting applied)
- Any warnings about data truncation or formatting limits
