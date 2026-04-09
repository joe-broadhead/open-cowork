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
  name: 'google-keep',
  version: '1.0.0',
})

// ─── CREATE NOTE ───

server.tool(
  'create_note',
  'Create a new Google Keep note.',
  {
    title: z.string().optional().describe('Note title'),
    text: z.string().describe('Note body text'),
  },
  async ({ title, text }) => {
    const body: Record<string, unknown> = {
      body: { text: { text } },
    }
    if (title) body.title = title
    const result = await gws(['keep', 'notes', 'create', '--json', JSON.stringify(body)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET NOTE ───

server.tool(
  'get_note',
  'Get the contents of a specific Google Keep note.',
  {
    name: z.string().describe('Note resource name (e.g. "notes/NOTE_ID")'),
  },
  async ({ name }) => {
    const result = await gws(['keep', 'notes', 'get', '--params', JSON.stringify({ name })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST NOTES ───

server.tool(
  'list_notes',
  'List Google Keep notes.',
  {
    pageSize: z.number().optional().describe('Maximum number of notes to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
    filter: z.string().optional().describe('Filter string (e.g. \'trashed=false\')'),
  },
  async ({ pageSize, pageToken, filter }) => {
    const args = ['keep', 'notes', 'list']
    const params: Record<string, unknown> = {}
    if (pageSize !== undefined) params.pageSize = pageSize
    if (pageToken) params.pageToken = pageToken
    if (filter) params.filter = filter
    if (Object.keys(params).length) args.push('--params', JSON.stringify(params))
    const result = await gws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE NOTE ───

server.tool(
  'delete_note',
  'Delete a Google Keep note.',
  {
    name: z.string().describe('Note resource name (e.g. "notes/NOTE_ID")'),
  },
  async ({ name }) => {
    const result = await gws(['keep', 'notes', 'delete', '--params', JSON.stringify({ name })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

const DISCOVERY_URL = 'https://keep.googleapis.com/$discovery/rest?version=v1'
let cachedDiscovery: any = null

async function getDiscovery(): Promise<any> {
  if (cachedDiscovery) return cachedDiscovery
  const res = await fetch(DISCOVERY_URL)
  if (!res.ok) throw new Error(`Discovery Service returned ${res.status}: ${res.statusText}`)
  cachedDiscovery = await res.json()
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
  'Look up the Google Keep API schema from the live Discovery Service. Browse available resources and data types.',
  {
    resource: z.string().optional().describe('Resource/schema name to look up (e.g. "Note", "Section", "TextContent", "ListContent"). Leave empty to list all available schemas.'),
  },
  async ({ resource }) => {
    try {
      const discovery = await getDiscovery()
      const schemas = discovery.schemas || {}

      if (!resource) {
        const types = Object.entries(schemas).map(([name, val]: [string, any]) => {
          return `- **${name}**: ${val.description || ''}`
        })
        return { content: [{ type: 'text' as const, text: `# Available Keep API schemas (${types.length})\n\n${types.join('\n')}` }] }
      }

      let schema = schemas[resource]
      if (!schema) {
        const key = Object.keys(schemas).find(k => k.toLowerCase() === resource.toLowerCase())
        if (key) schema = schemas[key]
      }

      if (!schema) {
        const matches = Object.keys(schemas).filter(k => k.toLowerCase().includes(resource.toLowerCase()))
        if (matches.length) {
          return { content: [{ type: 'text' as const, text: `"${resource}" not found. Did you mean:\n${matches.map(m => `- ${m}`).join('\n')}` }] }
        }
        return { content: [{ type: 'text' as const, text: `"${resource}" not found. Call schema() to list all types.` }] }
      }

      const resolved = resolveRef(schemas, resource)
      return { content: [{ type: 'text' as const, text: `# ${resource}\n\n${resolved.description || ''}\n\n## Structure\n\n\`\`\`json\n${JSON.stringify(resolved.properties || {}, null, 2)}\n\`\`\`` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed to fetch schema: ${err.message}` }] }
    }
  },
)

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-keep-mcp] Server started')
}
main().catch((err) => { console.error('[google-keep-mcp] Fatal:', err); process.exit(1) })
