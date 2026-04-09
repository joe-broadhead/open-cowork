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
  'Create a new Google Slides presentation. Returns the presentation ID and URL.',
  { title: z.string().describe('Title for the new presentation') },
  async ({ title }) => {
    const result = await gws(['slides', 'presentations', 'create', '--json', JSON.stringify({ title })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET ───

server.tool(
  'get',
  'Get a presentation\'s full content: slides, layouts, masters, and all page elements.',
  {
    presentationId: z.string().describe('The presentation ID'),
  },
  async ({ presentationId }) => {
    const result = await gws(['slides', 'presentations', 'get', '--params', JSON.stringify({ presentationId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET PAGE ───

server.tool(
  'get_page',
  'Get the content of a specific slide by its page object ID.',
  {
    presentationId: z.string().describe('The presentation ID'),
    pageObjectId: z.string().describe('The page/slide object ID'),
  },
  async ({ presentationId, pageObjectId }) => {
    const result = await gws(['slides', 'presentations', 'pages', 'get', '--params', JSON.stringify({ presentationId, pageObjectId })])
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
    const result = await gws(['slides', 'presentations', 'pages', 'getThumbnail', '--params', JSON.stringify({ presentationId, pageObjectId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE SLIDE ───

server.tool(
  'create_slide',
  'Add a new slide to the presentation. Optionally specify a layout.',
  {
    presentationId: z.string().describe('The presentation ID'),
    insertionIndex: z.number().optional().describe('Position to insert (0-based). Omit to append at end.'),
    layoutId: z.string().optional().describe('Layout object ID to use. Get available layouts from the `get` tool response.'),
    objectId: z.string().optional().describe('Custom object ID for the new slide. Auto-generated if omitted.'),
  },
  async ({ presentationId, insertionIndex, layoutId, objectId }) => {
    const req: any = { createSlide: {} }
    if (insertionIndex !== undefined) req.createSlide.insertionIndex = insertionIndex
    if (layoutId) req.createSlide.slideLayoutReference = { layoutId }
    if (objectId) req.createSlide.objectId = objectId
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [req] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE SLIDE / ELEMENT ───

server.tool(
  'delete_object',
  'Delete a slide or page element by its object ID.',
  {
    presentationId: z.string().describe('The presentation ID'),
    objectId: z.string().describe('Object ID of the slide or element to delete'),
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
  'Insert text into a shape or table cell on a slide.',
  {
    presentationId: z.string().describe('The presentation ID'),
    objectId: z.string().describe('Object ID of the shape or table cell'),
    text: z.string().describe('Text to insert'),
    insertionIndex: z.number().default(0).describe('Character index within the shape (0 = beginning)'),
  },
  async ({ presentationId, objectId, text, insertionIndex }) => {
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({
        requests: [{ insertText: { objectId, text, insertionIndex } }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE SHAPE ───

server.tool(
  'create_shape',
  'Create a shape (text box, rectangle, etc.) on a slide.',
  {
    presentationId: z.string().describe('The presentation ID'),
    pageObjectId: z.string().describe('Slide object ID to add the shape to'),
    shapeType: z.enum(['TEXT_BOX', 'RECTANGLE', 'ROUND_RECTANGLE', 'ELLIPSE', 'TRIANGLE', 'DIAMOND', 'STAR_5', 'ARROW_EAST', 'ARROW_NORTH', 'CALLOUT']).default('TEXT_BOX').describe('Shape type'),
    x: z.number().describe('X position in EMU (1 inch = 914400 EMU) or points * 12700'),
    y: z.number().describe('Y position in EMU'),
    width: z.number().describe('Width in EMU'),
    height: z.number().describe('Height in EMU'),
    objectId: z.string().optional().describe('Custom object ID. Auto-generated if omitted.'),
  },
  async ({ presentationId, pageObjectId, shapeType, x, y, width, height, objectId }) => {
    const req: any = {
      createShape: {
        shapeType,
        elementProperties: {
          pageObjectId,
          size: {
            width: { magnitude: width, unit: 'EMU' },
            height: { magnitude: height, unit: 'EMU' },
          },
          transform: {
            scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU',
          },
        },
      },
    }
    if (objectId) req.createShape.objectId = objectId
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests: [req] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE IMAGE ───

server.tool(
  'create_image',
  'Add an image to a slide from a URL.',
  {
    presentationId: z.string().describe('The presentation ID'),
    pageObjectId: z.string().describe('Slide object ID'),
    url: z.string().describe('Public URL of the image'),
    x: z.number().describe('X position in EMU'),
    y: z.number().describe('Y position in EMU'),
    width: z.number().describe('Width in EMU'),
    height: z.number().describe('Height in EMU'),
  },
  async ({ presentationId, pageObjectId, url, x, y, width, height }) => {
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({
        requests: [{
          createImage: {
            url,
            elementProperties: {
              pageObjectId,
              size: { width: { magnitude: width, unit: 'EMU' }, height: { magnitude: height, unit: 'EMU' } },
              transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' },
            },
          },
        }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE TABLE ───

server.tool(
  'create_table',
  'Create a table on a slide.',
  {
    presentationId: z.string().describe('The presentation ID'),
    pageObjectId: z.string().describe('Slide object ID'),
    rows: z.number().describe('Number of rows'),
    columns: z.number().describe('Number of columns'),
    x: z.number().describe('X position in EMU'),
    y: z.number().describe('Y position in EMU'),
    width: z.number().describe('Width in EMU'),
    height: z.number().describe('Height in EMU'),
  },
  async ({ presentationId, pageObjectId, rows, columns, x, y, width, height }) => {
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({
        requests: [{
          createTable: {
            rows, columns,
            elementProperties: {
              pageObjectId,
              size: { width: { magnitude: width, unit: 'EMU' }, height: { magnitude: height, unit: 'EMU' } },
              transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' },
            },
          },
        }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE TEXT STYLE ───

server.tool(
  'update_text_style',
  'Style text in a shape: bold, italic, font, color, size, links.',
  {
    presentationId: z.string().describe('The presentation ID'),
    objectId: z.string().describe('Shape object ID containing the text'),
    startIndex: z.number().default(0).describe('Start of text range'),
    endIndex: z.number().describe('End of text range (exclusive)'),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    fontSize: z.number().optional().describe('Font size in points'),
    fontFamily: z.string().optional().describe('Font family (e.g. "Arial")'),
    foregroundColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe('Text color RGB 0-1'),
    link: z.string().optional().describe('URL to link text to'),
  },
  async ({ presentationId, objectId, startIndex, endIndex, bold, italic, underline, fontSize, fontFamily, foregroundColor, link }) => {
    const style: Record<string, unknown> = {}
    const fields: string[] = []
    if (bold !== undefined) { style.bold = bold; fields.push('bold') }
    if (italic !== undefined) { style.italic = italic; fields.push('italic') }
    if (underline !== undefined) { style.underline = underline; fields.push('underline') }
    if (fontSize !== undefined) { style.fontSize = { magnitude: fontSize, unit: 'PT' }; fields.push('fontSize') }
    if (fontFamily) { style.fontFamily = fontFamily; fields.push('fontFamily') }
    if (foregroundColor) { style.foregroundColor = { opaqueColor: { rgbColor: foregroundColor } }; fields.push('foregroundColor') }
    if (link) { style.link = { url: link }; fields.push('link') }
    if (fields.length === 0) throw new Error('At least one style property is required')

    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({
        requests: [{
          updateTextStyle: {
            objectId,
            textRange: { type: 'FIXED_RANGE', startIndex, endIndex },
            style,
            fields: fields.join(','),
          },
        }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE SHAPE PROPERTIES ───

server.tool(
  'update_shape_properties',
  'Update shape appearance: fill color, outline, shadow.',
  {
    presentationId: z.string().describe('The presentation ID'),
    objectId: z.string().describe('Shape object ID'),
    fillColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe('Fill color RGB 0-1'),
    outlineColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe('Outline color RGB 0-1'),
    outlineWeight: z.number().optional().describe('Outline width in points'),
  },
  async ({ presentationId, objectId, fillColor, outlineColor, outlineWeight }) => {
    const props: Record<string, unknown> = {}
    const fields: string[] = []
    if (fillColor) {
      props.shapeBackgroundFill = { solidFill: { color: { rgbColor: fillColor } } }
      fields.push('shapeBackgroundFill.solidFill.color')
    }
    if (outlineColor || outlineWeight !== undefined) {
      const outline: any = {}
      if (outlineColor) outline.outlineFill = { solidFill: { color: { rgbColor: outlineColor } } }
      if (outlineWeight !== undefined) outline.weight = { magnitude: outlineWeight, unit: 'PT' }
      props.outline = outline
      fields.push('outline')
    }
    if (fields.length === 0) throw new Error('At least one property is required')

    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({
        requests: [{ updateShapeProperties: { objectId, shapeProperties: props, fields: fields.join(',') } }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── REPLACE ALL TEXT ───

server.tool(
  'replace_all_text',
  'Find and replace all instances of text across the entire presentation.',
  {
    presentationId: z.string().describe('The presentation ID'),
    find: z.string().describe('Text to find'),
    replace: z.string().describe('Replacement text'),
    matchCase: z.boolean().default(true).describe('Case-sensitive match'),
  },
  async ({ presentationId, find, replace, matchCase }) => {
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({
        requests: [{ replaceAllText: { containsText: { text: find, matchCase }, replaceText: replace } }],
      }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DUPLICATE SLIDE ───

server.tool(
  'duplicate_slide',
  'Duplicate a slide (and optionally its elements).',
  {
    presentationId: z.string().describe('The presentation ID'),
    objectId: z.string().describe('Object ID of the slide to duplicate'),
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
    slideObjectIds: z.array(z.string()).describe('Object IDs of slides to move'),
    insertionIndex: z.number().describe('New 0-based position for the slides'),
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

// ─── BATCH UPDATE (raw) ───

server.tool(
  'batch_update',
  'Apply one or more raw updates. For advanced operations: videos, Sheets chart embeds, line properties, page properties, speaker notes, and more. Call `schema` first.',
  {
    presentationId: z.string().describe('The presentation ID'),
    requests: z.array(z.record(z.unknown())).describe('Array of request objects. Call schema() to see available types.'),
  },
  async ({ presentationId, requests }) => {
    if (requests.length === 0) throw new Error('At least one request is required')
    const result = await gws([
      'slides', 'presentations', 'batchUpdate',
      '--params', JSON.stringify({ presentationId }),
      '--json', JSON.stringify({ requests }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

const DISCOVERY_URL = 'https://slides.googleapis.com/$discovery/rest?version=v1'
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
        result.properties[key] = { type: 'array', description: val.description, items: resolveRef(schemas, val.items.$ref, depth + 1) }
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
  'Look up the Google Slides API schema from the live Discovery Service. Use BEFORE batch_update. Search by request type (e.g. "createSheetsChart", "updatePageProperties").',
  {
    request_type: z.string().optional().describe('Specific request type. Leave empty to list all 44 available types.'),
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
        return { content: [{ type: 'text' as const, text: `# Available Slides batch_update request types (${types.length})\n\n${types.join('\n')}` }] }
      }

      const prop = requestSchema[request_type]
      if (!prop) {
        const matches = Object.keys(requestSchema).filter(k => k.toLowerCase().includes(request_type.toLowerCase()))
        if (matches.length) {
          return { content: [{ type: 'text' as const, text: `"${request_type}" not found. Did you mean:\n${matches.map(m => `- ${m}`).join('\n')}` }] }
        }
        return { content: [{ type: 'text' as const, text: `"${request_type}" not found. Call schema() to list all types.` }] }
      }

      const ref = prop.$ref
      if (!ref || !schemas[ref]) return { content: [{ type: 'text' as const, text: `# ${request_type}\n\nNo detailed schema available.` }] }

      const resolved = resolveRef(schemas, ref)
      return { content: [{ type: 'text' as const, text: `# ${request_type}\n\n${resolved.description || ''}\n\n## Structure\n\n\`{"${request_type}": { ... }}\`\n\n\`\`\`json\n${JSON.stringify(resolved.properties || {}, null, 2)}\n\`\`\`` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed to fetch schema: ${err.message}` }] }
    }
  },
)

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-slides-mcp] Server started')
}
main().catch((err) => { console.error('[google-slides-mcp] Fatal:', err); process.exit(1) })
