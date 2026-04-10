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
  name: 'google-people',
  version: '1.0.0',
})

// ─── LIST CONTACTS ───

server.tool(
  'list_contacts',
  'List the authenticated user\'s contacts.',
  {
    pageSize: z.number().default(20).describe('Maximum number of contacts to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
    personFields: z.string().default('names,emailAddresses,phoneNumbers').describe('Comma-separated person fields to return'),
    sortOrder: z.enum(['LAST_MODIFIED_ASCENDING', 'LAST_MODIFIED_DESCENDING', 'FIRST_NAME_ASCENDING', 'LAST_NAME_ASCENDING']).optional().describe('Sort order'),
  },
  async ({ pageSize, pageToken, personFields, sortOrder }) => {
    const params: Record<string, unknown> = { resourceName: 'people/me', pageSize, personFields }
    if (pageToken) params.pageToken = pageToken
    if (sortOrder) params.sortOrder = sortOrder
    const result = await gws(['people', 'people', 'connections', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SEARCH CONTACTS ───

server.tool(
  'search_contacts',
  'Search the user\'s contacts by name, email, phone, etc.',
  {
    query: z.string().describe('Search query string'),
    readMask: z.string().default('names,emailAddresses,phoneNumbers').describe('Comma-separated fields to return'),
    pageSize: z.number().optional().describe('Maximum number of results'),
  },
  async ({ query, readMask, pageSize }) => {
    const params: Record<string, unknown> = { query, readMask }
    if (pageSize !== undefined) params.pageSize = pageSize
    const result = await gws(['people', 'people', 'searchContacts', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET CONTACT ───

server.tool(
  'get_contact',
  'Get details for a specific contact by resource name.',
  {
    resourceName: z.string().describe('Contact resource name (e.g. "people/c123456789")'),
    personFields: z.string().default('names,emailAddresses,phoneNumbers,organizations,addresses,biographies').describe('Comma-separated person fields to return'),
  },
  async ({ resourceName, personFields }) => {
    const result = await gws(['people', 'people', 'get', '--params', JSON.stringify({ resourceName, personFields })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE CONTACT ───

server.tool(
  'create_contact',
  'Create a new contact.',
  {
    givenName: z.string().describe('First name'),
    familyName: z.string().optional().describe('Last name'),
    email: z.string().optional().describe('Email address'),
    emailType: z.string().optional().describe('Email type (e.g. "work", "home")'),
    phone: z.string().optional().describe('Phone number'),
    phoneType: z.string().optional().describe('Phone type (e.g. "mobile", "work")'),
    organization: z.string().optional().describe('Organization/company name'),
    title: z.string().optional().describe('Job title'),
  },
  async ({ givenName, familyName, email, emailType, phone, phoneType, organization, title }) => {
    const body: Record<string, unknown> = {
      names: [{ givenName, ...(familyName ? { familyName } : {}) }],
    }
    if (email) body.emailAddresses = [{ value: email, type: emailType || 'work' }]
    if (phone) body.phoneNumbers = [{ value: phone, type: phoneType || 'mobile' }]
    if (organization || title) body.organizations = [{ ...(organization ? { name: organization } : {}), ...(title ? { title } : {}) }]
    const result = await gws(['people', 'people', 'createContact', '--json', JSON.stringify(body)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE CONTACT ───

server.tool(
  'update_contact',
  'Update an existing contact. You must provide the resource name and etag (from get_contact).',
  {
    resourceName: z.string().describe('Contact resource name (e.g. "people/c123456789")'),
    etag: z.string().describe('The etag from the contact (required for updates, get it from get_contact)'),
    updatePersonFields: z.string().describe('Comma-separated fields being updated (e.g. "names,emailAddresses")'),
    givenName: z.string().optional().describe('Updated first name'),
    familyName: z.string().optional().describe('Updated last name'),
    email: z.string().optional().describe('Updated email address'),
    phone: z.string().optional().describe('Updated phone number'),
  },
  async ({ resourceName, etag, updatePersonFields, givenName, familyName, email, phone }) => {
    const body: Record<string, unknown> = { etag }
    if (givenName || familyName) body.names = [{ ...(givenName ? { givenName } : {}), ...(familyName ? { familyName } : {}) }]
    if (email) body.emailAddresses = [{ value: email }]
    if (phone) body.phoneNumbers = [{ value: phone }]
    const result = await gws([
      'people', 'people', 'updateContact',
      '--params', JSON.stringify({ resourceName, updatePersonFields }),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE CONTACT ───

server.tool(
  'delete_contact',
  'Delete a contact by resource name.',
  {
    resourceName: z.string().describe('Contact resource name (e.g. "people/c123456789")'),
  },
  async ({ resourceName }) => {
    const result = await gws(['people', 'people', 'deleteContact', '--params', JSON.stringify({ resourceName })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST CONTACT GROUPS ───

server.tool(
  'list_contact_groups',
  'List all contact groups (labels) for the user.',
  {
    pageSize: z.number().optional().describe('Maximum number of groups to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
  },
  async ({ pageSize, pageToken }) => {
    const args = ['people', 'contactGroups', 'list']
    const params: Record<string, unknown> = {}
    if (pageSize !== undefined) params.pageSize = pageSize
    if (pageToken) params.pageToken = pageToken
    if (Object.keys(params).length) args.push('--params', JSON.stringify(params))
    const result = await gws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

const DISCOVERY_URL = 'https://people.googleapis.com/$discovery/rest?version=v1'
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
  'Look up the Google People API schema from the live Discovery Service. Browse available resources and data types.',
  {
    resource: z.string().optional().describe('Resource/schema name to look up (e.g. "Person", "EmailAddress", "PhoneNumber", "ContactGroup"). Leave empty to list all available schemas.'),
  },
  async ({ resource }) => {
    try {
      const discovery = await getDiscovery()
      const schemas = discovery.schemas || {}

      if (!resource) {
        const types = Object.entries(schemas).map(([name, val]: [string, any]) => {
          return `- **${name}**: ${val.description || ''}`
        })
        return { content: [{ type: 'text' as const, text: `# Available People API schemas (${types.length})\n\n${types.join('\n')}` }] }
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

// ─── SEARCH DIRECTORY ───

server.tool(
  'search_directory',
  'Search the company directory (Workspace domain profiles). Different from personal contacts.',
  {
    query: z.string().describe('Search query (name or email)'),
    readMask: z.string().default('names,emailAddresses,phoneNumbers,organizations'),
  },
  async ({ query, readMask }) => {
    const result = await gws(['people', 'people', 'searchDirectoryPeople', '--params', JSON.stringify({
      query, readMask, sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
    })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST DIRECTORY ───

server.tool(
  'list_directory',
  'List people in the company directory.',
  {
    pageSize: z.number().default(20),
    readMask: z.string().default('names,emailAddresses,organizations'),
  },
  async ({ pageSize, readMask }) => {
    const result = await gws(['people', 'people', 'listDirectoryPeople', '--params', JSON.stringify({
      readMask, sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'], pageSize,
    })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── BATCH GET ───

server.tool(
  'batch_get',
  'Get multiple contacts at once by their resource names.',
  {
    resourceNames: z.array(z.string()).describe('Array of resource names (e.g. ["people/c123", "people/c456"])'),
    personFields: z.string().default('names,emailAddresses,phoneNumbers'),
  },
  async ({ resourceNames, personFields }) => {
    const result = await gws(['people', 'people', 'getBatchGet', '--params', JSON.stringify({ resourceNames, personFields })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE CONTACT GROUP ───

server.tool(
  'create_contact_group',
  'Create a new contact group (label).',
  { name: z.string().describe('Group name') },
  async ({ name }) => {
    const result = await gws(['people', 'contactGroups', 'create', '--json', JSON.stringify({ contactGroup: { name } })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE CONTACT GROUP ───

server.tool(
  'delete_contact_group',
  'Delete a contact group.',
  { resourceName: z.string().describe('Group resource name (e.g. "contactGroups/xxx")') },
  async ({ resourceName }) => {
    const result = await gws(['people', 'contactGroups', 'delete', '--params', JSON.stringify({ resourceName })])
    return { content: [{ type: 'text' as const, text: result || 'Group deleted' }] }
  },
)

// ─── MODIFY GROUP MEMBERS ───

server.tool(
  'modify_group_members',
  'Add or remove contacts from a contact group.',
  {
    resourceName: z.string().describe('Group resource name (e.g. "contactGroups/xxx")'),
    addMembers: z.array(z.string()).optional().describe('Contact resource names to add'),
    removeMembers: z.array(z.string()).optional().describe('Contact resource names to remove'),
  },
  async ({ resourceName, addMembers, removeMembers }) => {
    const body: Record<string, unknown> = {}
    if (addMembers?.length) body.resourceNamesToAdd = addMembers
    if (removeMembers?.length) body.resourceNamesToRemove = removeMembers
    const result = await gws(['people', 'contactGroups', 'members', 'modify', '--params', JSON.stringify({ resourceName }), '--json', JSON.stringify(body)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST OTHER CONTACTS ───

server.tool(
  'list_other_contacts',
  'List "Other contacts" — people auto-added from email interactions.',
  {
    pageSize: z.number().default(20),
    readMask: z.string().default('names,emailAddresses'),
  },
  async ({ pageSize, readMask }) => {
    const result = await gws(['people', 'otherContacts', 'list', '--params', JSON.stringify({ readMask, pageSize })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CUSTOM API CALL ───

server.tool(
  'run_api_call',
  'Run a custom gws people API call for operations not covered by other tools.',
  {
    args: z.array(z.string()).describe('gws command arguments after "people", e.g. ["people", "searchContacts", "--params", "{}"]'),
  },
  async ({ args }) => {
    const result = await gws(['people', ...args])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-people-mcp] Server started')
}
main().catch((err) => { console.error('[google-people-mcp] Fatal:', err); process.exit(1) })
