import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const execFileAsync = promisify(execFile)

function findGwsBinary(): string {
  if (process.env.GWS_BIN) return process.env.GWS_BIN
  try {
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve('@googleworkspace/cli/package.json')
    const binPath = resolve(dirname(pkgPath), 'bin', 'gws')
    if (existsSync(binPath)) return binPath
  } catch {}
  return 'gws'
}

const GWS = findGwsBinary()

async function gws(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(GWS, args, {
      timeout: 60_000,
      env: {
        ...process.env,
        ...(process.env.GOOGLE_WORKSPACE_CLI_TOKEN
          ? { GOOGLE_WORKSPACE_CLI_TOKEN: process.env.GOOGLE_WORKSPACE_CLI_TOKEN }
          : {}),
      },
    })
    if (stderr) console.error('[gws]', stderr)
    return stdout
  } catch (err: any) {
    throw new Error(`gws failed: ${err.message}\n${err.stderr || ''}`)
  }
}

const server = new McpServer({
  name: 'google-sheets',
  version: '1.0.0',
})

// ─── CREATE ───

server.tool(
  'create',
  'Create a new Google Sheets spreadsheet. Returns the spreadsheet ID and URL.',
  { title: z.string().describe('Title for the new spreadsheet') },
  async ({ title }) => {
    const result = await gws(['sheets', 'spreadsheets', 'create', '--json', JSON.stringify({ properties: { title } })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET ───

server.tool(
  'get',
  'Get spreadsheet metadata including sheet names, properties, and structure.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    includeGridData: z.boolean().default(false).describe('Include cell data (can be large)'),
  },
  async ({ spreadsheetId, includeGridData }) => {
    const params: Record<string, unknown> = { spreadsheetId, includeGridData }
    const result = await gws(['sheets', 'spreadsheets', 'get', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── READ VALUES ───

server.tool(
  'read',
  'Read values from a range in a spreadsheet. Use A1 notation for the range (e.g. "Sheet1!A1:D10").',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('The A1 notation range to read (e.g. "Sheet1!A1:D10", "Sheet1")'),
  },
  async ({ spreadsheetId, range }) => {
    const result = await gws(['sheets', 'spreadsheets', 'values', 'get', '--params', JSON.stringify({ spreadsheetId, range })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── WRITE VALUES ───

server.tool(
  'write',
  'Write values to a specific range in a spreadsheet. Overwrites existing data in the range.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('The A1 notation range to write to (e.g. "Sheet1!A1")'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of values: [[row1col1, row1col2], [row2col1, row2col2]]'),
  },
  async ({ spreadsheetId, range, values }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'values', 'update',
      '--params', JSON.stringify({ spreadsheetId, range, valueInputOption: 'USER_ENTERED' }),
      '--json', JSON.stringify({ range, values }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── APPEND VALUES ───

server.tool(
  'append',
  'Append rows to the end of a table in a spreadsheet. Automatically finds the last row.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().default('Sheet1').describe('The sheet or range to append to'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of rows to append: [[col1, col2], [col1, col2]]'),
  },
  async ({ spreadsheetId, range, values }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'values', 'append',
      '--params', JSON.stringify({ spreadsheetId, range, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' }),
      '--json', JSON.stringify({ range, values }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CLEAR VALUES ───

server.tool(
  'clear',
  'Clear all values from a range in a spreadsheet. Keeps formatting.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('The A1 notation range to clear (e.g. "Sheet1!A1:D10")'),
  },
  async ({ spreadsheetId, range }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'values', 'clear',
      '--params', JSON.stringify({ spreadsheetId, range }),
      '--json', '{}',
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── BATCH READ ───

server.tool(
  'batch_read',
  'Read multiple ranges from a spreadsheet in one call.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    ranges: z.array(z.string()).describe('Array of A1 notation ranges to read'),
  },
  async ({ spreadsheetId, ranges }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'values', 'batchGet',
      '--params', JSON.stringify({ spreadsheetId, ranges }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── BATCH WRITE ───

server.tool(
  'batch_write',
  'Write to multiple ranges in a spreadsheet in one call.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    data: z.array(z.object({
      range: z.string().describe('A1 notation range'),
      values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of values'),
    })).describe('Array of { range, values } objects'),
  },
  async ({ spreadsheetId, data }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'values', 'batchUpdate',
      '--params', JSON.stringify({ spreadsheetId }),
      '--json', JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── BATCH UPDATE (formatting, charts, sheets management) ───

server.tool(
  'batch_update',
  'Apply one or more updates to a spreadsheet: add/delete sheets, format cells, create charts, merge cells, sort, add filters, conditional formatting, and more. Uses the Sheets batchUpdate API — pass an array of request objects.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    requests: z.array(z.record(z.unknown())).describe('Array of request objects. See: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request'),
  },
  async ({ spreadsheetId, requests }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'batchUpdate',
      '--params', JSON.stringify({ spreadsheetId }),
      '--json', JSON.stringify({ requests }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── ADD SHEET ───

server.tool(
  'add_sheet',
  'Add a new sheet (tab) to a spreadsheet.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    title: z.string().describe('Name for the new sheet tab'),
  },
  async ({ spreadsheetId, title }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'batchUpdate',
      '--params', JSON.stringify({ spreadsheetId }),
      '--json', JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── FORMAT CELLS ───

server.tool(
  'format_cells',
  'Apply formatting to a range of cells: bold, colors, font size, number format, alignment, borders.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    sheetId: z.number().default(0).describe('The sheet ID (0 for the first sheet)'),
    startRow: z.number().describe('Start row index (0-based)'),
    endRow: z.number().describe('End row index (exclusive)'),
    startCol: z.number().describe('Start column index (0-based)'),
    endCol: z.number().describe('End column index (exclusive)'),
    bold: z.boolean().optional().describe('Make text bold'),
    fontSize: z.number().optional().describe('Font size in points'),
    bgColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe('Background color (RGB 0-1)'),
    textColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe('Text color (RGB 0-1)'),
    horizontalAlignment: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional().describe('Horizontal alignment'),
    numberFormat: z.object({ type: z.string(), pattern: z.string() }).optional().describe('Number format (e.g. {type:"PERCENT", pattern:"0.00%"})'),
  },
  async ({ spreadsheetId, sheetId, startRow, endRow, startCol, endCol, bold, fontSize, bgColor, textColor, horizontalAlignment, numberFormat }) => {
    const cellFormat: Record<string, unknown> = {}
    const textFormat: Record<string, unknown> = {}
    if (bold !== undefined) textFormat.bold = bold
    if (fontSize !== undefined) textFormat.fontSize = fontSize
    if (textColor) textFormat.foregroundColor = textColor
    if (Object.keys(textFormat).length) cellFormat.textFormat = textFormat
    if (bgColor) cellFormat.backgroundColor = bgColor
    if (horizontalAlignment) cellFormat.horizontalAlignment = horizontalAlignment
    if (numberFormat) cellFormat.numberFormat = numberFormat

    const fields = Object.keys(cellFormat).map(k => `userEnteredFormat.${k}`).join(',')

    const result = await gws([
      'sheets', 'spreadsheets', 'batchUpdate',
      '--params', JSON.stringify({ spreadsheetId }),
      '--json', JSON.stringify({
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
            cell: { userEnteredFormat: cellFormat },
            fields: `userEnteredFormat(${fields.replace(/userEnteredFormat\./g, '')})`,
          },
        }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── AUTO RESIZE ───

server.tool(
  'auto_resize',
  'Auto-resize columns or rows to fit content.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    sheetId: z.number().default(0).describe('The sheet ID'),
    dimension: z.enum(['COLUMNS', 'ROWS']).default('COLUMNS').describe('Resize columns or rows'),
    startIndex: z.number().default(0).describe('Start index'),
    endIndex: z.number().describe('End index (exclusive)'),
  },
  async ({ spreadsheetId, sheetId, dimension, startIndex, endIndex }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'batchUpdate',
      '--params', JSON.stringify({ spreadsheetId }),
      '--json', JSON.stringify({
        requests: [{
          autoResizeDimensions: {
            dimensions: { sheetId, dimension, startIndex, endIndex },
          },
        }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── COPY SHEET ───

server.tool(
  'copy_sheet',
  'Copy a sheet from one spreadsheet to another.',
  {
    spreadsheetId: z.string().describe('Source spreadsheet ID'),
    sheetId: z.number().describe('Sheet ID to copy'),
    destinationSpreadsheetId: z.string().describe('Destination spreadsheet ID'),
  },
  async ({ spreadsheetId, sheetId, destinationSpreadsheetId }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'sheets', 'copyTo',
      '--params', JSON.stringify({ spreadsheetId, sheetId }),
      '--json', JSON.stringify({ destinationSpreadsheetId }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── HELPER: Quick append ───

server.tool(
  'quick_append',
  'Quickly append a single row using comma-separated values. Simpler than the full append tool.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    values: z.string().describe('Comma-separated values for one row (e.g. "Name,Score,Grade")'),
    range: z.string().default('Sheet1').describe('Sheet name to append to'),
  },
  async ({ spreadsheetId, values, range }) => {
    const result = await gws(['sheets', '+append', '--spreadsheet', spreadsheetId, '--values', values, '--range', range])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── HELPER: Quick read ───

server.tool(
  'quick_read',
  'Quickly read values from a spreadsheet using the helper command.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().default('Sheet1').describe('Range to read (e.g. "Sheet1!A1:D10")'),
  },
  async ({ spreadsheetId, range }) => {
    const result = await gws(['sheets', '+read', '--spreadsheet', spreadsheetId, '--range', range])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA: batch_update request reference ───

const BATCH_UPDATE_SCHEMA = `# Google Sheets batch_update Request Types

Use with the \`batch_update\` tool. Pass an array of request objects.

## Sheet Management

### addSheet
Add a new tab.
\`\`\`json
{"addSheet": {"properties": {"title": "New Tab", "index": 0}}}
\`\`\`

### deleteSheet
Delete a tab by sheetId.
\`\`\`json
{"deleteSheet": {"sheetId": 1}}
\`\`\`

### updateSheetProperties
Update tab name, hide/show, freeze rows/cols, grid size.
\`\`\`json
{"updateSheetProperties": {"properties": {"sheetId": 0, "title": "Renamed", "hidden": false, "gridProperties": {"frozenRowCount": 1, "frozenColumnCount": 1}}, "fields": "title,hidden,gridProperties.frozenRowCount,gridProperties.frozenColumnCount"}}
\`\`\`

### duplicateSheet
\`\`\`json
{"duplicateSheet": {"sourceSheetId": 0, "insertSheetIndex": 1, "newSheetName": "Copy"}}
\`\`\`

## Cell Formatting

### repeatCell
Apply formatting to a range. Key fields in userEnteredFormat:
- textFormat: {bold, italic, underline, strikethrough, fontSize, fontFamily, foregroundColor: {red,green,blue}}
- backgroundColor: {red, green, blue} (values 0-1)
- horizontalAlignment: LEFT | CENTER | RIGHT
- verticalAlignment: TOP | MIDDLE | BOTTOM
- wrapStrategy: OVERFLOW_CELL | WRAP | CLIP
- numberFormat: {type: NUMBER|PERCENT|CURRENCY|DATE|TIME|SCIENTIFIC, pattern: "..."}
- borders: {top|bottom|left|right: {style: SOLID|DASHED|DOTTED, width: 1, color: {red,green,blue}}}

\`\`\`json
{"repeatCell": {"range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 0, "endColumnIndex": 5}, "cell": {"userEnteredFormat": {"textFormat": {"bold": true, "fontSize": 11}, "backgroundColor": {"red": 0.1, "green": 0.1, "blue": 0.15}, "horizontalAlignment": "CENTER"}}, "fields": "userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)"}}
\`\`\`

### updateBorders
\`\`\`json
{"updateBorders": {"range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 10, "startColumnIndex": 0, "endColumnIndex": 5}, "top": {"style": "SOLID", "width": 1, "color": {"red": 0.3, "green": 0.3, "blue": 0.3}}, "bottom": {"style": "SOLID", "width": 1}, "innerHorizontal": {"style": "SOLID", "width": 1, "color": {"red": 0.9, "green": 0.9, "blue": 0.9}}}}
\`\`\`

## Merging

### mergeCells
\`\`\`json
{"mergeCells": {"range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 0, "endColumnIndex": 3}, "mergeType": "MERGE_ALL"}}
\`\`\`
mergeType: MERGE_ALL | MERGE_COLUMNS | MERGE_ROWS

### unmergeCells
\`\`\`json
{"unmergeCells": {"range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 0, "endColumnIndex": 3}}}
\`\`\`

## Sizing

### updateDimensionProperties
Set column width or row height.
\`\`\`json
{"updateDimensionProperties": {"range": {"sheetId": 0, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 1}, "properties": {"pixelSize": 200}, "fields": "pixelSize"}}
\`\`\`

### autoResizeDimensions
\`\`\`json
{"autoResizeDimensions": {"dimensions": {"sheetId": 0, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 5}}}
\`\`\`

### insertDimension
Insert rows or columns.
\`\`\`json
{"insertDimension": {"range": {"sheetId": 0, "dimension": "ROWS", "startIndex": 5, "endIndex": 8}, "inheritFromBefore": true}}
\`\`\`

### deleteDimension
Delete rows or columns.
\`\`\`json
{"deleteDimension": {"range": {"sheetId": 0, "dimension": "ROWS", "startIndex": 5, "endIndex": 8}}}
\`\`\`

## Sorting & Filtering

### sortRange
\`\`\`json
{"sortRange": {"range": {"sheetId": 0, "startRowIndex": 1, "endRowIndex": 100, "startColumnIndex": 0, "endColumnIndex": 5}, "sortSpecs": [{"dimensionIndex": 1, "sortOrder": "DESCENDING"}]}}
\`\`\`

### setBasicFilter
Add a filter view to headers.
\`\`\`json
{"setBasicFilter": {"filter": {"range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 100, "startColumnIndex": 0, "endColumnIndex": 5}}}}
\`\`\`

### clearBasicFilter
\`\`\`json
{"clearBasicFilter": {"sheetId": 0}}
\`\`\`

## Charts

### addChart
\`\`\`json
{"addChart": {"chart": {"spec": {"title": "Sales by Region", "basicChart": {"chartType": "BAR", "legendPosition": "BOTTOM_LEGEND", "axis": [{"position": "BOTTOM_AXIS", "title": "Region"}, {"position": "LEFT_AXIS", "title": "Revenue"}], "domains": [{"domain": {"sourceRange": {"sources": [{"sheetId": 0, "startRowIndex": 0, "endRowIndex": 10, "startColumnIndex": 0, "endColumnIndex": 1}]}}}], "series": [{"series": {"sourceRange": {"sources": [{"sheetId": 0, "startRowIndex": 0, "endRowIndex": 10, "startColumnIndex": 1, "endColumnIndex": 2}]}}, "targetAxis": "LEFT_AXIS"}]}}, "position": {"overlayPosition": {"anchorCell": {"sheetId": 0, "rowIndex": 0, "columnIndex": 4}, "widthPixels": 600, "heightPixels": 400}}}}}
\`\`\`
chartType: BAR | LINE | AREA | COLUMN | SCATTER | COMBO | PIE | STEPPED_AREA

### updateChartSpec / deleteEmbeddedObject
Use chartId from addChart response.

## Conditional Formatting

### addConditionalFormatRule
Color scale (gradient):
\`\`\`json
{"addConditionalFormatRule": {"rule": {"ranges": [{"sheetId": 0, "startRowIndex": 1, "endRowIndex": 50, "startColumnIndex": 1, "endColumnIndex": 2}], "gradientRule": {"minpoint": {"color": {"red": 0.96, "green": 0.26, "blue": 0.21}, "type": "MIN"}, "maxpoint": {"color": {"red": 0.26, "green": 0.62, "blue": 0.28}, "type": "MAX"}}}, "index": 0}}
\`\`\`

Boolean rule (highlight cells):
\`\`\`json
{"addConditionalFormatRule": {"rule": {"ranges": [{"sheetId": 0, "startRowIndex": 1, "endRowIndex": 50, "startColumnIndex": 2, "endColumnIndex": 3}], "booleanRule": {"condition": {"type": "NUMBER_GREATER", "values": [{"userEnteredValue": "100"}]}, "format": {"backgroundColor": {"red": 0.85, "green": 0.93, "blue": 0.83}}}}, "index": 0}}
\`\`\`
Condition types: NUMBER_GREATER | NUMBER_LESS | NUMBER_EQ | TEXT_CONTAINS | TEXT_NOT_CONTAINS | BLANK | NOT_BLANK | CUSTOM_FORMULA

## Data Validation

### setDataValidation
\`\`\`json
{"setDataValidation": {"range": {"sheetId": 0, "startRowIndex": 1, "endRowIndex": 100, "startColumnIndex": 2, "endColumnIndex": 3}, "rule": {"condition": {"type": "ONE_OF_LIST", "values": [{"userEnteredValue": "Yes"}, {"userEnteredValue": "No"}]}, "showCustomUi": true, "strict": true}}}
\`\`\`

## Notes

### updateCells (with notes)
\`\`\`json
{"updateCells": {"rows": [{"values": [{"note": "This is a note"}]}], "fields": "note", "start": {"sheetId": 0, "rowIndex": 0, "columnIndex": 0}}}
\`\`\`

## Range Reference
All ranges use 0-based indices:
- sheetId: 0 = first sheet (get sheetId from \`get\` tool)
- startRowIndex / endRowIndex: row range (endRow is exclusive)
- startColumnIndex / endColumnIndex: column range (endCol is exclusive)
- Column A=0, B=1, C=2, etc.
`

server.tool(
  'schema',
  'Get the complete batch_update API reference. Call this BEFORE using batch_update to look up the correct request format for charts, formatting, merging, sorting, filtering, conditional formatting, data validation, and more.',
  {
    topic: z.enum([
      'all', 'sheets', 'formatting', 'merging', 'sizing',
      'sorting', 'charts', 'conditional', 'validation',
    ]).default('all').describe('Filter schema to a specific topic'),
  },
  async ({ topic }) => {
    if (topic === 'all') {
      return { content: [{ type: 'text' as const, text: BATCH_UPDATE_SCHEMA }] }
    }
    // Extract relevant section
    const sections: Record<string, string[]> = {
      sheets: ['Sheet Management'],
      formatting: ['Cell Formatting'],
      merging: ['Merging'],
      sizing: ['Sizing'],
      sorting: ['Sorting & Filtering'],
      charts: ['Charts'],
      conditional: ['Conditional Formatting'],
      validation: ['Data Validation', 'Notes'],
    }
    const headings = sections[topic] || []
    const lines = BATCH_UPDATE_SCHEMA.split('\n')
    const result: string[] = ['# batch_update: ' + topic, '']
    let include = false
    for (const line of lines) {
      if (line.startsWith('## ')) {
        include = headings.some(h => line.includes(h))
      }
      if (include) result.push(line)
    }
    return { content: [{ type: 'text' as const, text: result.join('\n') || BATCH_UPDATE_SCHEMA }] }
  },
)

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-sheets-mcp] Server started')
}
main().catch((err) => { console.error('[google-sheets-mcp] Fatal:', err); process.exit(1) })
