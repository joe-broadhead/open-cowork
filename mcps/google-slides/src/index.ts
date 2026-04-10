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
  name: 'google-slides',
  version: '1.0.0',
})

// ─── CREATE ───

server.tool(
  'create',
  'Create a new blank presentation.',
  { title: z.string().describe('Presentation title') },
  async ({ title }) => {
    const result = await gws(['slides', 'presentations', 'create', '--json', JSON.stringify({ title })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST SLIDES (lightweight — returns only page IDs and titles, not full content) ───

server.tool(
  'list_slides',
  'List all slides in a presentation with their page IDs. Use this FIRST to discover page IDs before reading individual slides. Much lighter than getting the full presentation.',
  { presentationId: z.string().describe('The presentation ID') },
  async ({ presentationId }) => {
    // Use fields mask to only get slide IDs and basic properties — avoids downloading full content
    const result = await gws([
      'slides', 'presentations', 'get',
      '--params', JSON.stringify({
        presentationId,
        fields: 'presentationId,title,slides(objectId,slideProperties),pageSize,masters(objectId),layouts(objectId)',
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET (full presentation — WARNING: can be very large) ───

server.tool(
  'get',
  'Get the full presentation including all slide content. WARNING: Large presentations may exceed limits. Prefer list_slides + get_page for reading content page by page.',
  { presentationId: z.string().describe('The presentation ID') },
  async ({ presentationId }) => {
    const result = await gws([
      'slides', 'presentations', 'get',
      '--params', JSON.stringify({ presentationId }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET PAGE (read one slide at a time) ───

server.tool(
  'get_page',
  'Get the full content of a specific slide/page. Use list_slides first to discover page IDs.',
  {
    presentationId: z.string().describe('The presentation ID'),
    pageObjectId: z.string().describe('The page/slide object ID (from list_slides)'),
  },
  async ({ presentationId, pageObjectId }) => {
    const result = await gws([
      'slides', 'presentations', 'pages', 'get',
      '--params', JSON.stringify({ presentationId, pageObjectId }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET THUMBNAIL ───

server.tool(
  'get_thumbnail',
  'Get a thumbnail image URL for a specific slide.',
  {
    presentationId: z.string().describe('The presentation ID'),
    pageObjectId: z.string().describe('The page/slide object ID'),
  },
  async ({ presentationId, pageObjectId }) => {
    const result = await gws([
      'slides', 'presentations', 'pages', 'getThumbnail',
      '--params', JSON.stringify({ presentationId, pageObjectId }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE SLIDE ───

server.tool(
  'create_slide',
  'Add a new slide to the presentation.',
  {
    presentationId: z.string().describe('The presentation ID'),
    insertionIndex: z.number().optional().describe('Position to insert (0-based). Omit to append at end.'),
    layoutId: z.string().optional().describe('Layout object ID to use. Get from list_slides masters/layouts.'),
  },
  async ({ presentationId, insertionIndex, layoutId }) => {
    const request: Record<string, unknown> = { objectId: `slide_${Date.now()}` }
    if (insertionIndex !== undefined) request.insertionIndex = insertionIndex
    if (layoutId) request.slideLayoutReference = { layoutId }
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [{ createSlide: request }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE OBJECT ───

server.tool(
  'delete_object',
  'Delete a slide, shape, table, or any page element by its object ID.',
  {
    presentationId: z.string().describe('The presentation ID'),
    objectId: z.string().describe('The object ID to delete'),
  },
  async ({ presentationId, objectId }) => {
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [{ deleteObject: { objectId } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── INSERT TEXT ───

server.tool(
  'insert_text',
  'Insert text into a shape or text box on a slide.',
  {
    presentationId: z.string().describe('The presentation ID'),
    objectId: z.string().describe('The shape/text box object ID'),
    text: z.string().describe('Text to insert'),
    insertionIndex: z.number().default(0).describe('Character index to insert at (0 = start)'),
  },
  async ({ presentationId, objectId, text, insertionIndex }) => {
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [{ insertText: { objectId, text, insertionIndex } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE SHAPE ───

server.tool(
  'create_shape',
  'Create a shape (rectangle, text box, etc.) on a slide. Sizes in EMU (1 inch = 914400 EMU).',
  {
    presentationId: z.string().describe('The presentation ID'),
    pageObjectId: z.string().describe('The slide to add the shape to'),
    shapeType: z.string().default('TEXT_BOX').describe('Shape type: TEXT_BOX, RECTANGLE, ELLIPSE, etc.'),
    x: z.number().describe('X position in EMU'),
    y: z.number().describe('Y position in EMU'),
    width: z.number().describe('Width in EMU'),
    height: z.number().describe('Height in EMU'),
  },
  async ({ presentationId, pageObjectId, shapeType, x, y, width, height }) => {
    const objectId = `shape_${Date.now()}`
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [{ createShape: {
        objectId,
        shapeType,
        elementProperties: {
          pageObjectId,
          size: { width: { magnitude: width, unit: 'EMU' }, height: { magnitude: height, unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' },
        },
      } }] }),
    ])
    return { content: [{ type: 'text' as const, text: `Created shape ${objectId}\n${result}` }] }
  },
)

// ─── CREATE IMAGE ───

server.tool(
  'create_image',
  'Insert an image on a slide from a URL.',
  {
    presentationId: z.string().describe('The presentation ID'),
    pageObjectId: z.string().describe('The slide to add the image to'),
    url: z.string().describe('Public URL of the image'),
    x: z.number().describe('X position in EMU'),
    y: z.number().describe('Y position in EMU'),
    width: z.number().describe('Width in EMU'),
    height: z.number().describe('Height in EMU'),
  },
  async ({ presentationId, pageObjectId, url, x, y, width, height }) => {
    const objectId = `image_${Date.now()}`
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [{ createImage: {
        objectId,
        url,
        elementProperties: {
          pageObjectId,
          size: { width: { magnitude: width, unit: 'EMU' }, height: { magnitude: height, unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' },
        },
      } }] }),
    ])
    return { content: [{ type: 'text' as const, text: `Created image ${objectId}\n${result}` }] }
  },
)

// ─── CREATE TABLE ───

server.tool(
  'create_table',
  'Create a table on a slide.',
  {
    presentationId: z.string().describe('The presentation ID'),
    pageObjectId: z.string().describe('The slide to add the table to'),
    rows: z.number().describe('Number of rows'),
    columns: z.number().describe('Number of columns'),
    x: z.number().default(457200).describe('X position in EMU (default ~0.5 inch)'),
    y: z.number().default(1600000).describe('Y position in EMU'),
    width: z.number().default(8000000).describe('Width in EMU'),
    height: z.number().default(3000000).describe('Height in EMU'),
  },
  async ({ presentationId, pageObjectId, rows, columns, x, y, width, height }) => {
    const objectId = `table_${Date.now()}`
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [{ createTable: {
        objectId, rows, columns,
        elementProperties: {
          pageObjectId,
          size: { width: { magnitude: width, unit: 'EMU' }, height: { magnitude: height, unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' },
        },
      } }] }),
    ])
    return { content: [{ type: 'text' as const, text: `Created table ${objectId}\n${result}` }] }
  },
)

// ─── UPDATE TEXT STYLE ───

server.tool(
  'update_text_style',
  'Update text formatting (bold, italic, font size, color) in a shape.',
  {
    presentationId: z.string().describe('The presentation ID'),
    objectId: z.string().describe('The shape/text box object ID'),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    fontSize: z.number().optional().describe('Font size in points'),
    fontFamily: z.string().optional(),
    foregroundColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe('RGB values 0-1'),
  },
  async ({ presentationId, objectId, bold, italic, fontSize, fontFamily, foregroundColor }) => {
    const style: Record<string, unknown> = {}
    const fields: string[] = []
    if (bold !== undefined) { style.bold = bold; fields.push('bold') }
    if (italic !== undefined) { style.italic = italic; fields.push('italic') }
    if (fontSize !== undefined) { style.fontSize = { magnitude: fontSize, unit: 'PT' }; fields.push('fontSize') }
    if (fontFamily !== undefined) { style.fontFamily = fontFamily; fields.push('fontFamily') }
    if (foregroundColor) { style.foregroundColor = { opaqueColor: { rgbColor: foregroundColor } }; fields.push('foregroundColor') }

    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [{ updateTextStyle: {
        objectId,
        style,
        textRange: { type: 'ALL' },
        fields: fields.join(','),
      } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE SHAPE PROPERTIES ───

server.tool(
  'update_shape_properties',
  'Update shape fill, outline, or other visual properties.',
  {
    presentationId: z.string().describe('The presentation ID'),
    objectId: z.string().describe('The shape object ID'),
    backgroundColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe('RGB fill color (0-1)'),
  },
  async ({ presentationId, objectId, backgroundColor }) => {
    const properties: Record<string, unknown> = {}
    const fields: string[] = []
    if (backgroundColor) {
      properties.shapeBackgroundFill = { solidFill: { color: { rgbColor: backgroundColor } } }
      fields.push('shapeBackgroundFill.solidFill.color')
    }
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [{ updateShapeProperties: { objectId, shapeProperties: properties, fields: fields.join(',') } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── REPLACE ALL TEXT ───

server.tool(
  'replace_all_text',
  'Find and replace text across the entire presentation.',
  {
    presentationId: z.string().describe('The presentation ID'),
    findText: z.string().describe('Text to find'),
    replaceText: z.string().describe('Replacement text'),
    matchCase: z.boolean().default(false),
  },
  async ({ presentationId, findText, replaceText, matchCase }) => {
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [{ replaceAllText: {
        containsText: { text: findText, matchCase },
        replaceText,
      } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DUPLICATE SLIDE ───

server.tool(
  'duplicate_slide',
  'Duplicate an existing slide.',
  {
    presentationId: z.string().describe('The presentation ID'),
    objectId: z.string().describe('The slide object ID to duplicate'),
  },
  async ({ presentationId, objectId }) => {
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [{ duplicateObject: { objectId } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── REORDER SLIDES ───

server.tool(
  'reorder_slides',
  'Move slides to a new position in the presentation.',
  {
    presentationId: z.string().describe('The presentation ID'),
    slideObjectIds: z.array(z.string()).describe('Slide object IDs to move'),
    insertionIndex: z.number().describe('New position (0-based)'),
  },
  async ({ presentationId, slideObjectIds, insertionIndex }) => {
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [{ updateSlidesPosition: { slideObjectIds, insertionIndex } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── BATCH UPDATE (escape hatch) ───

server.tool(
  'batch_update',
  'Execute one or more raw Slides API batch update requests. Use for advanced operations not covered by other tools. Refer to the Google Slides API reference for request types.',
  {
    presentationId: z.string().describe('The presentation ID'),
    requests: z.array(z.record(z.unknown())).describe('Array of request objects (e.g. [{createSlide: {...}}, {insertText: {...}}])'),
  },
  async ({ presentationId, requests }) => {
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

server.tool(
  'schema',
  'Fetch the Google Slides API schema from Discovery Service. Use to discover available request types for batch_update.',
  {
    resource: z.string().optional().describe('Filter by resource (e.g. "presentations", "pages")'),
  },
  async ({ resource }) => {
    const res = await fetch('https://slides.googleapis.com/$discovery/rest?version=v1')
    const schema = await res.json() as any
    if (resource) {
      const r = schema.resources?.[resource]
      if (r) return { content: [{ type: 'text' as const, text: JSON.stringify(r.methods || {}, null, 2) }] }
      // Check nested resources
      for (const [name, val] of Object.entries(schema.resources || {})) {
        const nested = (val as any).resources?.[resource]
        if (nested) return { content: [{ type: 'text' as const, text: JSON.stringify(nested.methods || {}, null, 2) }] }
      }
      return { content: [{ type: 'text' as const, text: `Resource "${resource}" not found. Available: ${Object.keys(schema.resources || {}).join(', ')}` }] }
    }
    // Return schema overview for batch update request types
    const requestTypes = Object.keys(schema.schemas?.Request?.properties || {})
    return { content: [{ type: 'text' as const, text: `Slides API batch update request types:\n${requestTypes.join('\n')}\n\nUse schema with resource name for endpoint details.` }] }
  },
)

// ─── CUSTOM API CALL ───

server.tool(
  'run_api_call',
  'Run a custom gws slides API call for operations not covered by other tools.',
  {
    args: z.array(z.string()).describe('gws command arguments after "slides", e.g. ["presentations", "pages", "get", "--params", "{}"]'),
  },
  async ({ args }) => {
    const result = await gws(['slides', ...args])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

console.error('[google-slides-mcp] Server started')
const transport = new StdioServerTransport()
server.connect(transport)
