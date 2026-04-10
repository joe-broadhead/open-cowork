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
  name: 'google-docs',
  version: '1.0.0',
})

// ─── CREATE ───

server.tool(
  'create',
  'Create a new Google Docs document. Returns the document ID and URL.',
  { title: z.string().describe('Title for the new document') },
  async ({ title }) => {
    const result = await gws(['docs', 'documents', 'create', '--json', JSON.stringify({ title })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET ───

server.tool(
  'get',
  'Get a document\'s full content, structure, and metadata. Returns the document body with all paragraphs, tables, images, and styles.',
  {
    documentId: z.string().describe('The document ID'),
  },
  async ({ documentId }) => {
    const result = await gws(['docs', 'documents', 'get', '--params', JSON.stringify({ documentId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── QUICK WRITE (append text) ───

server.tool(
  'quick_write',
  'Quickly append plain text to the end of a document. For rich formatting, use batch_update instead.',
  {
    documentId: z.string().describe('The document ID'),
    text: z.string().describe('Plain text to append to the document'),
  },
  async ({ documentId, text }) => {
    const result = await gws(['docs', '+write', '--document', documentId, '--text', text])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── INSERT TEXT ───

server.tool(
  'insert_text',
  'Insert text at a specific position in the document.',
  {
    documentId: z.string().describe('The document ID'),
    text: z.string().describe('Text to insert'),
    index: z.number().describe('The 1-based character index where to insert. Use 1 to insert at the beginning.'),
  },
  async ({ documentId, text, index }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({
        requests: [{ insertText: { text, location: { index } } }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── INSERT TABLE ───

server.tool(
  'insert_table',
  'Insert a table at a specific position in the document.',
  {
    documentId: z.string().describe('The document ID'),
    rows: z.number().describe('Number of rows'),
    columns: z.number().describe('Number of columns'),
    index: z.number().describe('The 1-based character index where to insert the table'),
  },
  async ({ documentId, rows, columns, index }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({
        requests: [{ insertTable: { rows, columns, location: { index } } }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── INSERT IMAGE ───

server.tool(
  'insert_image',
  'Insert an image from a URL into the document.',
  {
    documentId: z.string().describe('The document ID'),
    uri: z.string().describe('Public URL of the image'),
    index: z.number().describe('The 1-based character index where to insert'),
    width: z.number().optional().describe('Width in points (72 points = 1 inch)'),
    height: z.number().optional().describe('Height in points'),
  },
  async ({ documentId, uri, index, width, height }) => {
    const req: any = { insertInlineImage: { uri, location: { index } } }
    if (width || height) {
      req.insertInlineImage.objectSize = {
        ...(width ? { width: { magnitude: width, unit: 'PT' } } : {}),
        ...(height ? { height: { magnitude: height, unit: 'PT' } } : {}),
      }
    }
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({ requests: [req] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── REPLACE ALL TEXT ───

server.tool(
  'replace_all_text',
  'Find and replace all instances of text in the document.',
  {
    documentId: z.string().describe('The document ID'),
    find: z.string().describe('Text to find'),
    replace: z.string().describe('Replacement text'),
    matchCase: z.boolean().default(true).describe('Case-sensitive matching'),
  },
  async ({ documentId, find, replace, matchCase }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({
        requests: [{
          replaceAllText: {
            containsText: { text: find, matchCase },
            replaceText: replace,
          },
        }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE CONTENT ───

server.tool(
  'delete_content',
  'Delete content from a range in the document.',
  {
    documentId: z.string().describe('The document ID'),
    startIndex: z.number().describe('Start index of the range to delete (1-based)'),
    endIndex: z.number().describe('End index of the range to delete (exclusive)'),
  },
  async ({ documentId, startIndex, endIndex }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({
        requests: [{ deleteContentRange: { range: { startIndex, endIndex } } }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE TEXT STYLE ───

server.tool(
  'update_text_style',
  'Apply text styling (bold, italic, font, color, size, links) to a range.',
  {
    documentId: z.string().describe('The document ID'),
    startIndex: z.number().describe('Start of the range (1-based)'),
    endIndex: z.number().describe('End of the range (exclusive)'),
    bold: z.boolean().optional().describe('Make text bold'),
    italic: z.boolean().optional().describe('Make text italic'),
    underline: z.boolean().optional().describe('Underline text'),
    strikethrough: z.boolean().optional().describe('Strikethrough text'),
    fontSize: z.number().optional().describe('Font size in points'),
    fontFamily: z.string().optional().describe('Font family name (e.g. "Arial", "Roboto")'),
    foregroundColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe('Text color (RGB 0-1)'),
    link: z.string().optional().describe('URL to link the text to'),
  },
  async ({ documentId, startIndex, endIndex, bold, italic, underline, strikethrough, fontSize, fontFamily, foregroundColor, link }) => {
    const textStyle: Record<string, unknown> = {}
    const fields: string[] = []

    if (bold !== undefined) { textStyle.bold = bold; fields.push('bold') }
    if (italic !== undefined) { textStyle.italic = italic; fields.push('italic') }
    if (underline !== undefined) { textStyle.underline = underline; fields.push('underline') }
    if (strikethrough !== undefined) { textStyle.strikethrough = strikethrough; fields.push('strikethrough') }
    if (fontSize !== undefined) { textStyle.fontSize = { magnitude: fontSize, unit: 'PT' }; fields.push('fontSize') }
    if (fontFamily) { textStyle.weightedFontFamily = { fontFamily }; fields.push('weightedFontFamily') }
    if (foregroundColor) { textStyle.foregroundColor = { color: { rgbColor: foregroundColor } }; fields.push('foregroundColor') }
    if (link) { textStyle.link = { url: link }; fields.push('link') }

    if (fields.length === 0) throw new Error('At least one style property is required')

    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({
        requests: [{
          updateTextStyle: {
            range: { startIndex, endIndex },
            textStyle,
            fields: fields.join(','),
          },
        }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE PARAGRAPH STYLE ───

server.tool(
  'update_paragraph_style',
  'Update paragraph styling: alignment, headings, spacing, indentation, bullet lists.',
  {
    documentId: z.string().describe('The document ID'),
    startIndex: z.number().describe('Start of the range (1-based)'),
    endIndex: z.number().describe('End of the range (exclusive)'),
    namedStyleType: z.enum(['NORMAL_TEXT', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6', 'TITLE', 'SUBTITLE']).optional().describe('Apply a named style'),
    alignment: z.enum(['START', 'CENTER', 'END', 'JUSTIFIED']).optional().describe('Paragraph alignment'),
    lineSpacing: z.number().optional().describe('Line spacing as percentage (e.g. 115 for 1.15x)'),
    spaceAbove: z.number().optional().describe('Space above paragraph in points'),
    spaceBelow: z.number().optional().describe('Space below paragraph in points'),
  },
  async ({ documentId, startIndex, endIndex, namedStyleType, alignment, lineSpacing, spaceAbove, spaceBelow }) => {
    const paragraphStyle: Record<string, unknown> = {}
    const fields: string[] = []

    if (namedStyleType) { paragraphStyle.namedStyleType = namedStyleType; fields.push('namedStyleType') }
    if (alignment) { paragraphStyle.alignment = alignment; fields.push('alignment') }
    if (lineSpacing !== undefined) { paragraphStyle.lineSpacing = lineSpacing; fields.push('lineSpacing') }
    if (spaceAbove !== undefined) { paragraphStyle.spaceAbove = { magnitude: spaceAbove, unit: 'PT' }; fields.push('spaceAbove') }
    if (spaceBelow !== undefined) { paragraphStyle.spaceBelow = { magnitude: spaceBelow, unit: 'PT' }; fields.push('spaceBelow') }

    if (fields.length === 0) throw new Error('At least one paragraph style property is required')

    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({
        requests: [{
          updateParagraphStyle: {
            range: { startIndex, endIndex },
            paragraphStyle,
            fields: fields.join(','),
          },
        }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE BULLETS ───

server.tool(
  'create_bullets',
  'Create a bulleted or numbered list from paragraphs in a range.',
  {
    documentId: z.string().describe('The document ID'),
    startIndex: z.number().describe('Start of the range (1-based)'),
    endIndex: z.number().describe('End of the range (exclusive)'),
    bulletPreset: z.enum([
      'BULLET_DISC_CIRCLE_SQUARE', 'BULLET_DIAMONDX_ARROW3D_SQUARE',
      'BULLET_CHECKBOX', 'BULLET_ARROW_DIAMOND_DISC',
      'BULLET_STAR_CIRCLE_SQUARE', 'BULLET_ARROW3D_CIRCLE_SQUARE',
      'BULLET_LEFTTRIANGLE_DIAMOND_DISC', 'BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE',
      'NUMBERED_DECIMAL_ALPHA_ROMAN', 'NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS',
      'NUMBERED_DECIMAL_NESTED', 'NUMBERED_UPPERALPHA_ALPHA_ROMAN',
      'NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL', 'NUMBERED_ZERODECIMAL_ALPHA_ROMAN',
    ]).default('BULLET_DISC_CIRCLE_SQUARE').describe('Bullet style preset'),
  },
  async ({ documentId, startIndex, endIndex, bulletPreset }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({
        requests: [{ createParagraphBullets: { range: { startIndex, endIndex }, bulletPreset } }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── BATCH UPDATE (raw) ───

server.tool(
  'batch_update',
  'Apply one or more raw updates to the document. For advanced operations: headers, footers, page breaks, table cell styles, named ranges, section styles, and more. Call `schema` first to look up the request format.',
  {
    documentId: z.string().describe('The document ID'),
    requests: z.array(z.record(z.unknown())).describe('Array of request objects. Call schema() to see available types.'),
  },
  async ({ documentId, requests }) => {
    if (requests.length === 0) throw new Error('At least one request is required')
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({ requests }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA: Live API lookup from Google Discovery Service ───

const DISCOVERY_URL = 'https://docs.googleapis.com/$discovery/rest?version=v1'
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
  'Look up the Google Docs API schema from the live Discovery Service. Use BEFORE batch_update to get the exact request format. Search by request type name (e.g. "insertText", "updateTextStyle", "createHeader").',
  {
    request_type: z.string().optional().describe('Specific request type (e.g. "insertText", "updateParagraphStyle"). Leave empty to list all available types.'),
  },
  async ({ request_type }) => {
    try {
      const discovery = await getDiscovery()
      const schemas = discovery.schemas || {}
      const requestSchema = schemas.Request?.properties || {}

      if (!request_type) {
        const types = Object.entries(requestSchema).map(([name, val]: [string, any]) => {
          const ref = val.$ref
          const desc = ref && schemas[ref] ? schemas[ref].description : ''
          return `- **${name}**: ${desc}`
        })
        return { content: [{ type: 'text' as const, text: `# Available Docs batch_update request types (${types.length})\n\n${types.join('\n')}` }] }
      }

      const prop = requestSchema[request_type]
      if (!prop) {
        const matches = Object.keys(requestSchema).filter(k => k.toLowerCase().includes(request_type.toLowerCase()))
        if (matches.length) {
          return { content: [{ type: 'text' as const, text: `Request type "${request_type}" not found. Did you mean:\n${matches.map(m => `- ${m}`).join('\n')}` }] }
        }
        return { content: [{ type: 'text' as const, text: `Request type "${request_type}" not found. Call schema() to see all types.` }] }
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

// ─── INSERT PAGE BREAK ───

server.tool(
  'insert_page_break',
  'Insert a page break at the specified index. A newline is inserted before the page break.',
  {
    documentId: z.string().describe('The document ID'),
    index: z.number().describe('Character index to insert at (1-based)'),
  },
  async ({ documentId, index }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({ requests: [{ insertPageBreak: { location: { index } } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE HEADER ───

server.tool(
  'create_header',
  'Create a header for the document. Returns the header ID which you can then insert text into.',
  {
    documentId: z.string().describe('The document ID'),
    type: z.enum(['DEFAULT']).default('DEFAULT').describe('Header type'),
  },
  async ({ documentId, type }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({ requests: [{ createHeader: { type } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE FOOTER ───

server.tool(
  'create_footer',
  'Create a footer for the document. Returns the footer ID which you can then insert text into.',
  {
    documentId: z.string().describe('The document ID'),
    type: z.enum(['DEFAULT']).default('DEFAULT').describe('Footer type'),
  },
  async ({ documentId, type }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({ requests: [{ createFooter: { type } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── INSERT TABLE ROW ───

server.tool(
  'insert_table_row',
  'Insert a row into a table.',
  {
    documentId: z.string().describe('The document ID'),
    tableStartIndex: z.number().describe('Start index of the table in the document'),
    rowIndex: z.number().describe('Row index to insert at (0-based)'),
    insertBelow: z.boolean().default(true).describe('Insert below the reference row'),
  },
  async ({ documentId, tableStartIndex, rowIndex, insertBelow }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({ requests: [{ insertTableRow: {
        tableCellLocation: { tableStartLocation: { index: tableStartIndex }, rowIndex, columnIndex: 0 },
        insertBelow,
      } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── INSERT TABLE COLUMN ───

server.tool(
  'insert_table_column',
  'Insert a column into a table.',
  {
    documentId: z.string().describe('The document ID'),
    tableStartIndex: z.number().describe('Start index of the table in the document'),
    columnIndex: z.number().describe('Column index to insert at (0-based)'),
    insertRight: z.boolean().default(true).describe('Insert to the right of the reference column'),
  },
  async ({ documentId, tableStartIndex, columnIndex, insertRight }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({ requests: [{ insertTableColumn: {
        tableCellLocation: { tableStartLocation: { index: tableStartIndex }, rowIndex: 0, columnIndex },
        insertRight,
      } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE TABLE ROW ───

server.tool(
  'delete_table_row',
  'Delete a row from a table.',
  {
    documentId: z.string().describe('The document ID'),
    tableStartIndex: z.number().describe('Start index of the table'),
    rowIndex: z.number().describe('Row index to delete (0-based)'),
  },
  async ({ documentId, tableStartIndex, rowIndex }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({ requests: [{ deleteTableRow: {
        tableCellLocation: { tableStartLocation: { index: tableStartIndex }, rowIndex, columnIndex: 0 },
      } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE TABLE COLUMN ───

server.tool(
  'delete_table_column',
  'Delete a column from a table.',
  {
    documentId: z.string().describe('The document ID'),
    tableStartIndex: z.number().describe('Start index of the table'),
    columnIndex: z.number().describe('Column index to delete (0-based)'),
  },
  async ({ documentId, tableStartIndex, columnIndex }) => {
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({ requests: [{ deleteTableColumn: {
        tableCellLocation: { tableStartLocation: { index: tableStartIndex }, rowIndex: 0, columnIndex },
      } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE DOCUMENT STYLE ───

server.tool(
  'update_document_style',
  'Update global document style: margins, page size, default header/footer distance.',
  {
    documentId: z.string().describe('The document ID'),
    marginTop: z.number().optional().describe('Top margin in points'),
    marginBottom: z.number().optional().describe('Bottom margin in points'),
    marginLeft: z.number().optional().describe('Left margin in points'),
    marginRight: z.number().optional().describe('Right margin in points'),
  },
  async ({ documentId, marginTop, marginBottom, marginLeft, marginRight }) => {
    const style: Record<string, unknown> = {}
    const fields: string[] = []
    if (marginTop !== undefined) { style.marginTop = { magnitude: marginTop, unit: 'PT' }; fields.push('marginTop') }
    if (marginBottom !== undefined) { style.marginBottom = { magnitude: marginBottom, unit: 'PT' }; fields.push('marginBottom') }
    if (marginLeft !== undefined) { style.marginLeft = { magnitude: marginLeft, unit: 'PT' }; fields.push('marginLeft') }
    if (marginRight !== undefined) { style.marginRight = { magnitude: marginRight, unit: 'PT' }; fields.push('marginRight') }
    const result = await gws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId }),
      '--json', JSON.stringify({ requests: [{ updateDocumentStyle: { documentStyle: style, fields: fields.join(',') } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CUSTOM API CALL ───

server.tool(
  'run_api_call',
  'Run a custom gws docs API call for operations not covered by other tools.',
  {
    args: z.array(z.string()).describe('gws command arguments after "docs", e.g. ["documents", "get", "--params", "{}"]'),
  },
  async ({ args }) => {
    const result = await gws(['docs', ...args])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-docs-mcp] Server started')
}
main().catch((err) => { console.error('[google-docs-mcp] Fatal:', err); process.exit(1) })
