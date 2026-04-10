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
      timeout: 60_000, maxBuffer: 50 * 1024 * 1024,
      env: process.env,
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

    if (Object.keys(cellFormat).length === 0) {
      throw new Error('At least one formatting option is required (bold, fontSize, bgColor, textColor, horizontalAlignment, or numberFormat)')
    }

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
  'Quickly append rows. Use --values for a single row of comma-separated values, or pass a 2D JSON array for multiple rows.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    values: z.string().optional().describe('Comma-separated values for one row (e.g. "Name,Score,Grade")'),
    jsonValues: z.string().optional().describe('JSON array of rows for bulk append (e.g. \'[["a","b"],["c","d"]]\')'),
  },
  async ({ spreadsheetId, values, jsonValues }) => {
    if (!values && !jsonValues) throw new Error('Provide either values or jsonValues')
    const args = ['sheets', '+append', '--spreadsheet', spreadsheetId]
    if (jsonValues) {
      args.push('--json-values', jsonValues)
    } else if (values) {
      args.push('--values', values)
    }
    const result = await gws(args)
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

// ─── SCHEMA: Live API schema from Google Discovery Service ───

const DISCOVERY_URL = 'https://sheets.googleapis.com/$discovery/rest?version=v4'
let cachedDiscovery: any = null

async function getDiscovery(): Promise<any> {
  if (cachedDiscovery) return cachedDiscovery
  const res = await fetch(DISCOVERY_URL)
  if (!res.ok) throw new Error(`Discovery Service returned ${res.status}: ${res.statusText}`)
  const data: any = await res.json()
  if (!data.schemas?.Request) throw new Error('Invalid Discovery response: missing Request schema')
  cachedDiscovery = data
  return cachedDiscovery
}

function resolveRef(schemas: any, ref: string, depth = 0): any {
  if (depth > 5) return { type: 'object', description: `(see ${ref})` }
  const schema = schemas[ref]
  if (!schema) return { type: 'unknown' }
  const result: any = { description: schema.description }
  if (schema.properties) {
    result.properties = {}
    for (const [key, val] of Object.entries(schema.properties) as any) {
      if (val.$ref) {
        result.properties[key] = resolveRef(schemas, val.$ref, depth + 1)
      } else if (val.items?.$ref) {
        // Resolve array item types so the agent sees the full structure
        const resolved = resolveRef(schemas, val.items.$ref, depth + 1)
        result.properties[key] = { type: 'array', description: val.description, items: resolved }
      } else {
        result.properties[key] = { type: val.type || val.enum?.join('|') || 'any', description: val.description }
        if (val.enum) result.properties[key].enum = val.enum
      }
    }
  }
  if (schema.enum) result.enum = schema.enum
  return result
}

server.tool(
  'schema',
  'Look up the Google Sheets API schema from the live Discovery Service. Use this BEFORE batch_update to get the exact request format. Search by request type name (e.g. "addChart", "repeatCell", "addConditionalFormatRule").',
  {
    request_type: z.string().optional().describe('Specific request type to look up (e.g. "addChart", "repeatCell", "mergeCells"). Leave empty to list all available request types.'),
  },
  async ({ request_type }) => {
    try {
      const discovery = await getDiscovery()
      const schemas = discovery.schemas || {}
      const requestSchema = schemas.Request?.properties || {}

      if (!request_type) {
        // List all available request types with descriptions
        const types = Object.entries(requestSchema).map(([name, val]: [string, any]) => {
          const ref = val.$ref
          const desc = ref && schemas[ref] ? schemas[ref].description : val.description || ''
          return `- **${name}**: ${desc}`
        })
        return { content: [{ type: 'text' as const, text: `# Available batch_update request types (${types.length})\n\n${types.join('\n')}` }] }
      }

      // Look up specific request type
      const prop = requestSchema[request_type]
      if (!prop) {
        // Fuzzy search
        const matches = Object.keys(requestSchema).filter(k => k.toLowerCase().includes(request_type.toLowerCase()))
        if (matches.length) {
          return { content: [{ type: 'text' as const, text: `Request type "${request_type}" not found. Did you mean:\n${matches.map(m => `- ${m}`).join('\n')}` }] }
        }
        return { content: [{ type: 'text' as const, text: `Request type "${request_type}" not found. Call schema() without arguments to see all types.` }] }
      }

      const ref = prop.$ref
      if (!ref || !schemas[ref]) {
        return { content: [{ type: 'text' as const, text: `# ${request_type}\n\nNo detailed schema available.` }] }
      }

      const resolved = resolveRef(schemas, ref)
      const output = `# ${request_type}\n\n${resolved.description || ''}\n\n## Structure\n\nUse as: \`{"${request_type}": { ... }}\`\n\n\`\`\`json\n${JSON.stringify(resolved.properties || {}, null, 2)}\n\`\`\``

      return { content: [{ type: 'text' as const, text: output }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed to fetch schema: ${err.message}` }] }
    }
  },
)

// ─── BATCH CLEAR ───

server.tool(
  'batch_clear',
  'Clear values from multiple ranges in one atomic operation.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    ranges: z.array(z.string()).describe('Ranges to clear (e.g. ["Sheet1!A:Z", "Sheet2!A1:D10"])'),
  },
  async ({ spreadsheetId, ranges }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'values', 'batchClear',
      '--params', JSON.stringify({ spreadsheetId }),
      '--json', JSON.stringify({ ranges }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE SHEET ───

server.tool(
  'delete_sheet',
  'Delete a sheet tab from the spreadsheet by its sheet ID (numeric, not name). Use `get` first to find sheet IDs.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    sheetId: z.number().describe('The numeric sheet ID (from spreadsheet get → sheets[].properties.sheetId)'),
  },
  async ({ spreadsheetId, sheetId }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'batchUpdate',
      '--params', JSON.stringify({ spreadsheetId }),
      '--json', JSON.stringify({ requests: [{ deleteSheet: { sheetId } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── RENAME SHEET ───

server.tool(
  'rename_sheet',
  'Rename a sheet tab. Use `get` first to find the numeric sheet ID.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    sheetId: z.number().describe('The numeric sheet ID'),
    title: z.string().describe('New name for the sheet tab'),
  },
  async ({ spreadsheetId, sheetId, title }) => {
    const result = await gws([
      'sheets', 'spreadsheets', 'batchUpdate',
      '--params', JSON.stringify({ spreadsheetId }),
      '--json', JSON.stringify({ requests: [{ updateSheetProperties: { properties: { sheetId, title }, fields: 'title' } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CUSTOM API CALL ───

server.tool(
  'run_api_call',
  'Run a custom gws sheets API call for operations not covered by other tools. Use schema tool to discover endpoints.',
  {
    args: z.array(z.string()).describe('gws command arguments after "sheets", e.g. ["spreadsheets", "values", "batchClear", "--params", "{}"]'),
  },
  async ({ args }) => {
    const result = await gws(['sheets', ...args])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-sheets-mcp] Server started')
}
main().catch((err) => { console.error('[google-sheets-mcp] Fatal:', err); process.exit(1) })
