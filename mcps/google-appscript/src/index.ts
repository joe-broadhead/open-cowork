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
  name: 'google-appscript',
  version: '1.0.0',
})

// ─── PROJECT MANAGEMENT ───

server.tool(
  'create_project',
  'Create a new, empty Apps Script project.',
  {
    title: z.string().describe('Project title'),
    parentId: z.string().optional().describe('Drive ID of the parent file (Sheet, Doc, etc.) to bind the script to'),
  },
  async ({ title, parentId }) => {
    const body: Record<string, unknown> = { title }
    if (parentId) body.parentId = parentId
    const result = await gws(['script', 'projects', 'create', '--json', JSON.stringify(body)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

server.tool(
  'get_project',
  'Get a script project\'s metadata (title, parent, create/update times).',
  {
    scriptId: z.string().describe('The script project ID'),
  },
  async ({ scriptId }) => {
    const result = await gws(['script', 'projects', 'get', '--params', JSON.stringify({ scriptId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

server.tool(
  'get_content',
  'Get all source files in a script project (code + manifest).',
  {
    scriptId: z.string().describe('The script project ID'),
  },
  async ({ scriptId }) => {
    const result = await gws(['script', 'projects', 'getContent', '--params', JSON.stringify({ scriptId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

server.tool(
  'update_content',
  'Replace all source files in a script project. Provide the complete set of files (code + manifest).',
  {
    scriptId: z.string().describe('The script project ID'),
    files: z.array(z.object({
      name: z.string().describe('File name without extension (e.g. "Code", "Utilities")'),
      type: z.enum(['SERVER_JS', 'HTML', 'JSON']).describe('SERVER_JS for .gs files, HTML for .html, JSON for appsscript.json'),
      source: z.string().describe('The full source code of the file'),
    })).describe('Array of file objects. Must include appsscript.json manifest.'),
  },
  async ({ scriptId, files }) => {
    const result = await gws([
      'script', 'projects', 'updateContent',
      '--params', JSON.stringify({ scriptId }),
      '--json', JSON.stringify({ scriptId, files }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

server.tool(
  'get_metrics',
  'Get usage metrics for a script project (executions, errors, active users).',
  {
    scriptId: z.string().describe('The script project ID'),
  },
  async ({ scriptId }) => {
    const result = await gws(['script', 'projects', 'getMetrics', '--params', JSON.stringify({ scriptId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCRIPT EXECUTION ───

server.tool(
  'run',
  'Execute a function in a deployed Apps Script project. The project must have a deployed API executable, and the function must be accessible.',
  {
    scriptId: z.string().describe('The script project ID'),
    function: z.string().describe('Name of the function to execute'),
    parameters: z.array(z.unknown()).optional().describe('Array of parameters to pass to the function'),
    devMode: z.boolean().default(false).describe('Run against the most recent saved code (not the deployed version)'),
  },
  async ({ scriptId, function: fn, parameters, devMode }) => {
    const body: Record<string, unknown> = { function: fn, devMode }
    if (parameters) body.parameters = parameters
    const result = await gws([
      'script', 'scripts', 'run',
      '--params', JSON.stringify({ scriptId }),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DEPLOYMENTS ───

server.tool(
  'list_deployments',
  'List all deployments of a script project.',
  {
    scriptId: z.string().describe('The script project ID'),
  },
  async ({ scriptId }) => {
    const result = await gws(['script', 'projects', 'deployments', 'list', '--params', JSON.stringify({ scriptId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

server.tool(
  'create_deployment',
  'Create a new deployment of a script project.',
  {
    scriptId: z.string().describe('The script project ID'),
    versionNumber: z.number().optional().describe('Version number to deploy. If omitted, deploys HEAD.'),
    description: z.string().optional().describe('Description of this deployment'),
  },
  async ({ scriptId, versionNumber, description }) => {
    const config: Record<string, unknown> = {}
    if (versionNumber !== undefined) config.versionNumber = versionNumber
    if (description) config.description = description
    const result = await gws([
      'script', 'projects', 'deployments', 'create',
      '--params', JSON.stringify({ scriptId }),
      '--json', JSON.stringify({ deploymentConfig: config }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

server.tool(
  'update_deployment',
  'Update an existing deployment (change version or description).',
  {
    scriptId: z.string().describe('The script project ID'),
    deploymentId: z.string().describe('The deployment ID'),
    versionNumber: z.number().optional().describe('New version number'),
    description: z.string().optional().describe('New description'),
  },
  async ({ scriptId, deploymentId, versionNumber, description }) => {
    const config: Record<string, unknown> = {}
    if (versionNumber !== undefined) config.versionNumber = versionNumber
    if (description) config.description = description
    const result = await gws([
      'script', 'projects', 'deployments', 'update',
      '--params', JSON.stringify({ scriptId, deploymentId }),
      '--json', JSON.stringify({ deploymentConfig: config }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

server.tool(
  'delete_deployment',
  'Delete a deployment.',
  {
    scriptId: z.string().describe('The script project ID'),
    deploymentId: z.string().describe('The deployment ID'),
  },
  async ({ scriptId, deploymentId }) => {
    const result = await gws(['script', 'projects', 'deployments', 'delete', '--params', JSON.stringify({ scriptId, deploymentId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── VERSIONS ───

server.tool(
  'create_version',
  'Create a new immutable version of the script project from the current code.',
  {
    scriptId: z.string().describe('The script project ID'),
    description: z.string().optional().describe('Version description'),
  },
  async ({ scriptId, description }) => {
    const body: Record<string, unknown> = {}
    if (description) body.description = description
    const result = await gws([
      'script', 'projects', 'versions', 'create',
      '--params', JSON.stringify({ scriptId }),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

server.tool(
  'list_versions',
  'List all versions of a script project.',
  {
    scriptId: z.string().describe('The script project ID'),
  },
  async ({ scriptId }) => {
    const result = await gws(['script', 'projects', 'versions', 'list', '--params', JSON.stringify({ scriptId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── PROCESSES ───

server.tool(
  'list_processes',
  'List recent execution processes for the user.',
  {},
  async () => {
    const result = await gws(['script', 'processes', 'list'])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

server.tool(
  'list_script_processes',
  'List execution processes for a specific script.',
  {
    scriptId: z.string().describe('The script project ID'),
  },
  async ({ scriptId }) => {
    const result = await gws(['script', 'processes', 'listScriptProcesses', '--params', JSON.stringify({ scriptId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

const DISCOVERY_URL = 'https://script.googleapis.com/$discovery/rest?version=v1'
let cachedDiscovery: any = null

async function getDiscovery(): Promise<any> {
  if (cachedDiscovery) return cachedDiscovery
  const res = await fetch(DISCOVERY_URL)
  if (!res.ok) throw new Error(`Discovery Service returned ${res.status}: ${res.statusText}`)
  const data: any = await res.json()
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
  'Look up the Apps Script API schema. Browse available resource types, methods, and data structures.',
  {
    resource: z.string().optional().describe('Schema name to look up (e.g. "File", "Project", "ExecutionRequest", "Content"). Leave empty to list all schemas.'),
  },
  async ({ resource }) => {
    try {
      const discovery = await getDiscovery()
      const schemas = discovery.schemas || {}

      if (!resource) {
        const types = Object.entries(schemas).map(([name, val]: [string, any]) => {
          return `- **${name}**: ${(val as any).description || ''}`
        })
        return { content: [{ type: 'text' as const, text: `# Apps Script API schemas (${types.length})\n\n${types.join('\n')}` }] }
      }

      if (!schemas[resource]) {
        const matches = Object.keys(schemas).filter(k => k.toLowerCase().includes(resource.toLowerCase()))
        if (matches.length) {
          return { content: [{ type: 'text' as const, text: `"${resource}" not found. Did you mean:\n${matches.map(m => `- ${m}`).join('\n')}` }] }
        }
        return { content: [{ type: 'text' as const, text: `"${resource}" not found. Call schema() to list all.` }] }
      }

      const resolved = resolveRef(schemas, resource)
      return { content: [{ type: 'text' as const, text: `# ${resource}\n\n${resolved.description || ''}\n\n\`\`\`json\n${JSON.stringify(resolved.properties || resolved, null, 2)}\n\`\`\`` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed to fetch schema: ${err.message}` }] }
    }
  },
)

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-appscript-mcp] Server started')
}
main().catch((err) => { console.error('[google-appscript-mcp] Fatal:', err); process.exit(1) })
