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
  name: 'google-forms',
  version: '1.0.0',
})

// ─── CREATE ───

server.tool(
  'create',
  'Create a new Google Form. Returns the form ID and responder URL.',
  {
    title: z.string().describe('Title for the new form'),
    documentTitle: z.string().optional().describe('Document title (defaults to form title)'),
  },
  async ({ title, documentTitle }) => {
    const body: Record<string, unknown> = { info: { title } }
    if (documentTitle) body.info = { ...body.info as object, documentTitle }
    const result = await gws(['forms', 'forms', 'create', '--json', JSON.stringify(body)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET ───

server.tool(
  'get',
  'Get a form\'s full structure including all questions, sections, and settings.',
  {
    formId: z.string().describe('The form ID'),
  },
  async ({ formId }) => {
    const result = await gws(['forms', 'forms', 'get', '--params', JSON.stringify({ formId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE (BATCH UPDATE) ───

server.tool(
  'update',
  'Apply one or more updates to a form: add/update/delete questions, change settings, move items. Uses the Forms batchUpdate API.',
  {
    formId: z.string().describe('The form ID'),
    requests: z.array(z.record(z.unknown())).describe('Array of update request objects (e.g. createItem, updateItem, deleteItem, updateFormInfo, updateSettings)'),
    includeFormInResponse: z.boolean().optional().describe('Include the updated form in the response'),
  },
  async ({ formId, requests, includeFormInResponse }) => {
    if (requests.length === 0) throw new Error('At least one request is required')
    const body: Record<string, unknown> = { requests }
    if (includeFormInResponse !== undefined) body.includeFormInResponse = includeFormInResponse
    const result = await gws([
      'forms', 'forms', 'batchUpdate',
      '--params', JSON.stringify({ formId }),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST RESPONSES ───

server.tool(
  'list_responses',
  'List all responses to a form.',
  {
    formId: z.string().describe('The form ID'),
    pageSize: z.number().optional().describe('Maximum number of responses to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
    filter: z.string().optional().describe('Filter (e.g. \'timestamp >= 2024-01-01T00:00:00Z\')'),
  },
  async ({ formId, pageSize, pageToken, filter }) => {
    const params: Record<string, unknown> = { formId }
    if (pageSize !== undefined) params.pageSize = pageSize
    if (pageToken) params.pageToken = pageToken
    if (filter) params.filter = filter
    const result = await gws(['forms', 'forms', 'responses', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET RESPONSE ───

server.tool(
  'get_response',
  'Get a specific form response by ID.',
  {
    formId: z.string().describe('The form ID'),
    responseId: z.string().describe('The response ID'),
  },
  async ({ formId, responseId }) => {
    const result = await gws(['forms', 'forms', 'responses', 'get', '--params', JSON.stringify({ formId, responseId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

const DISCOVERY_URL = 'https://forms.googleapis.com/$discovery/rest?version=v1'
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
  'Look up the Google Forms API schema from the live Discovery Service. Use BEFORE update to get the exact request format for batch updates.',
  {
    resource: z.string().optional().describe('Resource/schema name to look up (e.g. "Request", "Item", "Question", "Form"). Leave empty to list all available schemas.'),
  },
  async ({ resource }) => {
    try {
      const discovery = await getDiscovery()
      const schemas = discovery.schemas || {}

      if (!resource) {
        const types = Object.entries(schemas).map(([name, val]: [string, any]) => {
          return `- **${name}**: ${val.description || ''}`
        })
        return { content: [{ type: 'text' as const, text: `# Available Forms API schemas (${types.length})\n\n${types.join('\n')}` }] }
      }

      // Check for Request schema to list batch_update request types
      if (resource === 'Request' && schemas.Request?.properties) {
        const requestSchema = schemas.Request.properties
        const types = Object.entries(requestSchema).map(([name, val]: [string, any]) => {
          const ref = val.$ref
          const desc = ref && schemas[ref] ? schemas[ref].description : ''
          return `- **${name}**: ${desc}`
        })
        return { content: [{ type: 'text' as const, text: `# Available Forms batchUpdate request types (${types.length})\n\n${types.join('\n')}` }] }
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

// ─── ADD QUESTION (convenience) ───

server.tool(
  'add_question',
  'Add a question to a form. Use batchUpdate under the hood.',
  {
    formId: z.string().describe('The form ID'),
    title: z.string().describe('Question title/text'),
    questionType: z.enum(['SHORT_ANSWER', 'PARAGRAPH', 'MULTIPLE_CHOICE', 'CHECKBOXES', 'DROPDOWN', 'SCALE', 'DATE', 'TIME']).default('SHORT_ANSWER'),
    required: z.boolean().default(false),
    options: z.array(z.string()).optional().describe('Answer options (for MULTIPLE_CHOICE, CHECKBOXES, DROPDOWN)'),
  },
  async ({ formId, title, questionType, required, options }) => {
    const question: Record<string, unknown> = { required }
    if (['MULTIPLE_CHOICE', 'CHECKBOXES', 'DROPDOWN'].includes(questionType)) {
      question.choiceQuestion = {
        type: questionType === 'DROPDOWN' ? 'DROP_DOWN' : questionType === 'CHECKBOXES' ? 'CHECKBOX' : 'RADIO',
        options: (options || ['Option 1']).map(o => ({ value: o })),
      }
    } else if (questionType === 'SCALE') {
      question.scaleQuestion = { low: 1, high: 5, lowLabel: 'Low', highLabel: 'High' }
    } else if (questionType === 'DATE') {
      question.dateQuestion = {}
    } else if (questionType === 'TIME') {
      question.timeQuestion = {}
    } else {
      question.textQuestion = { paragraph: questionType === 'PARAGRAPH' }
    }
    const result = await gws([
      'forms', 'forms', 'batchUpdate',
      '--params', JSON.stringify({ formId }),
      '--json', JSON.stringify({ requests: [{ createItem: { item: { title, questionItem: { question } }, location: { index: 0 } } }] }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SET PUBLISH SETTINGS ───

server.tool(
  'set_publish_settings',
  'Update form publish settings (accepting responses, etc.).',
  {
    formId: z.string().describe('The form ID'),
    isAcceptingResponses: z.boolean().default(true),
  },
  async ({ formId, isAcceptingResponses }) => {
    const result = await gws([
      'forms', 'forms', 'setPublishSettings',
      '--params', JSON.stringify({ formId }),
      '--json', JSON.stringify({ publishSettings: { isAcceptingResponses } }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CUSTOM API CALL ───

server.tool(
  'run_api_call',
  'Run a custom gws forms API call for operations not covered by other tools.',
  {
    args: z.array(z.string()).describe('gws command arguments after "forms", e.g. ["forms", "get", "--params", "{}"]'),
  },
  async ({ args }) => {
    const result = await gws(['forms', ...args])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-forms-mcp] Server started')
}
main().catch((err) => { console.error('[google-forms-mcp] Fatal:', err); process.exit(1) })
