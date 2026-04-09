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
  name: 'google-tasks',
  version: '1.0.0',
})

// ─── LIST TASK LISTS ───

server.tool(
  'list_task_lists',
  'List all task lists for the authenticated user.',
  {
    maxResults: z.number().optional().describe('Maximum number of task lists to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
  },
  async ({ maxResults, pageToken }) => {
    const args = ['tasks', 'tasklists', 'list']
    const params: Record<string, unknown> = {}
    if (maxResults !== undefined) params.maxResults = maxResults
    if (pageToken) params.pageToken = pageToken
    if (Object.keys(params).length) args.push('--params', JSON.stringify(params))
    const result = await gws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE TASK LIST ───

server.tool(
  'create_task_list',
  'Create a new task list.',
  {
    title: z.string().describe('Title for the new task list'),
  },
  async ({ title }) => {
    const result = await gws(['tasks', 'tasklists', 'insert', '--json', JSON.stringify({ title })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE TASK LIST ───

server.tool(
  'delete_task_list',
  'Delete a task list.',
  {
    tasklist: z.string().describe('Task list ID to delete'),
  },
  async ({ tasklist }) => {
    const result = await gws(['tasks', 'tasklists', 'delete', '--params', JSON.stringify({ tasklist })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST TASKS ───

server.tool(
  'list_tasks',
  'List tasks in a specific task list.',
  {
    tasklist: z.string().describe('Task list ID'),
    maxResults: z.number().optional().describe('Maximum number of tasks to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
    showCompleted: z.boolean().optional().describe('Include completed tasks (default true)'),
    showHidden: z.boolean().optional().describe('Include hidden tasks'),
    showDeleted: z.boolean().optional().describe('Include deleted tasks'),
    dueMin: z.string().optional().describe('Lower bound for due date (RFC3339 timestamp)'),
    dueMax: z.string().optional().describe('Upper bound for due date (RFC3339 timestamp)'),
  },
  async ({ tasklist, maxResults, pageToken, showCompleted, showHidden, showDeleted, dueMin, dueMax }) => {
    const params: Record<string, unknown> = { tasklist }
    if (maxResults !== undefined) params.maxResults = maxResults
    if (pageToken) params.pageToken = pageToken
    if (showCompleted !== undefined) params.showCompleted = showCompleted
    if (showHidden !== undefined) params.showHidden = showHidden
    if (showDeleted !== undefined) params.showDeleted = showDeleted
    if (dueMin) params.dueMin = dueMin
    if (dueMax) params.dueMax = dueMax
    const result = await gws(['tasks', 'tasks', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET TASK ───

server.tool(
  'get_task',
  'Get the full details of a specific task.',
  {
    tasklist: z.string().describe('Task list ID'),
    task: z.string().describe('Task ID'),
  },
  async ({ tasklist, task }) => {
    const result = await gws(['tasks', 'tasks', 'get', '--params', JSON.stringify({ tasklist, task })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE TASK ───

server.tool(
  'create_task',
  'Create a new task in a task list.',
  {
    tasklist: z.string().describe('Task list ID'),
    title: z.string().describe('Task title'),
    notes: z.string().optional().describe('Task notes/description'),
    due: z.string().optional().describe('Due date (RFC3339 timestamp, e.g. "2024-06-15T00:00:00Z")'),
    parent: z.string().optional().describe('Parent task ID (to create a subtask)'),
    previous: z.string().optional().describe('Previous sibling task ID (for ordering)'),
  },
  async ({ tasklist, title, notes, due, parent, previous }) => {
    const body: Record<string, unknown> = { title }
    if (notes) body.notes = notes
    if (due) body.due = due
    const params: Record<string, unknown> = { tasklist }
    if (parent) params.parent = parent
    if (previous) params.previous = previous
    const result = await gws([
      'tasks', 'tasks', 'insert',
      '--params', JSON.stringify(params),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE TASK ───

server.tool(
  'update_task',
  'Update an existing task. Only provided fields will be changed.',
  {
    tasklist: z.string().describe('Task list ID'),
    task: z.string().describe('Task ID'),
    title: z.string().optional().describe('Updated task title'),
    notes: z.string().optional().describe('Updated notes/description'),
    due: z.string().optional().describe('Updated due date (RFC3339 timestamp)'),
    status: z.enum(['needsAction', 'completed']).optional().describe('Task status'),
  },
  async ({ tasklist, task, title, notes, due, status }) => {
    const body: Record<string, unknown> = {}
    if (title) body.title = title
    if (notes !== undefined) body.notes = notes
    if (due) body.due = due
    if (status) body.status = status
    if (Object.keys(body).length === 0) throw new Error('At least one field to update is required')
    const result = await gws([
      'tasks', 'tasks', 'patch',
      '--params', JSON.stringify({ tasklist, task }),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE TASK ───

server.tool(
  'delete_task',
  'Delete a task.',
  {
    tasklist: z.string().describe('Task list ID'),
    task: z.string().describe('Task ID to delete'),
  },
  async ({ tasklist, task }) => {
    const result = await gws(['tasks', 'tasks', 'delete', '--params', JSON.stringify({ tasklist, task })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── COMPLETE TASK ───

server.tool(
  'complete_task',
  'Mark a task as completed.',
  {
    tasklist: z.string().describe('Task list ID'),
    task: z.string().describe('Task ID to complete'),
  },
  async ({ tasklist, task }) => {
    const result = await gws([
      'tasks', 'tasks', 'patch',
      '--params', JSON.stringify({ tasklist, task }),
      '--json', JSON.stringify({ status: 'completed' }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CLEAR COMPLETED ───

server.tool(
  'clear_completed',
  'Clear all completed tasks from a task list.',
  {
    tasklist: z.string().describe('Task list ID'),
  },
  async ({ tasklist }) => {
    const result = await gws(['tasks', 'tasks', 'clear', '--params', JSON.stringify({ tasklist })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── MOVE TASK ───

server.tool(
  'move_task',
  'Move/reorder a task within a task list.',
  {
    tasklist: z.string().describe('Task list ID'),
    task: z.string().describe('Task ID to move'),
    parent: z.string().optional().describe('New parent task ID (to make it a subtask). Pass empty string to move to top level.'),
    previous: z.string().optional().describe('Previous sibling task ID (for ordering). Omit to move to the first position.'),
  },
  async ({ tasklist, task, parent, previous }) => {
    const params: Record<string, unknown> = { tasklist, task }
    if (parent !== undefined) params.parent = parent
    if (previous) params.previous = previous
    const result = await gws(['tasks', 'tasks', 'move', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

const DISCOVERY_URL = 'https://tasks.googleapis.com/$discovery/rest?version=v2'
const DISCOVERY_URL_FALLBACK = 'https://tasks.googleapis.com/$discovery/rest'
let cachedDiscovery: any = null

async function getDiscovery(): Promise<any> {
  if (cachedDiscovery) return cachedDiscovery
  let res = await fetch(DISCOVERY_URL)
  if (!res.ok) {
    // Fallback to no version
    res = await fetch(DISCOVERY_URL_FALLBACK)
  }
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
  'Look up the Google Tasks API schema from the live Discovery Service. Browse available resources and data types.',
  {
    resource: z.string().optional().describe('Resource/schema name to look up (e.g. "Task", "TaskList", "Tasks"). Leave empty to list all available schemas.'),
  },
  async ({ resource }) => {
    try {
      const discovery = await getDiscovery()
      const schemas = discovery.schemas || {}

      if (!resource) {
        const types = Object.entries(schemas).map(([name, val]: [string, any]) => {
          return `- **${name}**: ${val.description || ''}`
        })
        return { content: [{ type: 'text' as const, text: `# Available Tasks API schemas (${types.length})\n\n${types.join('\n')}` }] }
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
  console.error('[google-tasks-mcp] Server started')
}
main().catch((err) => { console.error('[google-tasks-mcp] Fatal:', err); process.exit(1) })
