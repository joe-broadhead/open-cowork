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
  name: 'google-drive',
  version: '1.0.0',
})

// ─── LIST FILES ───

server.tool(
  'list_files',
  'List or search files in Google Drive.',
  {
    q: z.string().optional().describe('Drive search query (e.g. "name contains \'report\'", "mimeType=\'application/vnd.google-apps.spreadsheet\'", "trashed=false")'),
    pageSize: z.number().default(20).describe('Maximum number of files to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
    orderBy: z.string().optional().describe('Sort order (e.g. "modifiedTime desc", "name")'),
    fields: z.string().optional().describe('Fields to include (e.g. "files(id,name,mimeType,modifiedTime)")'),
    spaces: z.string().optional().describe('Comma-separated spaces to search (drive, appDataFolder)'),
  },
  async ({ q, pageSize, pageToken, orderBy, fields, spaces }) => {
    const params: Record<string, unknown> = { pageSize }
    if (q) params.q = q
    if (pageToken) params.pageToken = pageToken
    if (orderBy) params.orderBy = orderBy
    if (fields) params.fields = fields
    if (spaces) params.spaces = spaces
    const result = await gws(['drive', 'files', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET FILE ───

server.tool(
  'get_file',
  'Get file metadata from Google Drive.',
  {
    fileId: z.string().describe('The file ID'),
    fields: z.string().optional().describe('Specific fields to return (e.g. "id,name,mimeType,webViewLink,parents,size")'),
  },
  async ({ fileId, fields }) => {
    const params: Record<string, unknown> = { fileId }
    if (fields) params.fields = fields
    const result = await gws(['drive', 'files', 'get', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE FILE ───

server.tool(
  'create_file',
  'Create a new file or folder in Google Drive.',
  {
    name: z.string().describe('File name'),
    mimeType: z.string().describe('MIME type (e.g. "application/vnd.google-apps.folder", "application/vnd.google-apps.document", "text/plain")'),
    parents: z.array(z.string()).optional().describe('Parent folder IDs'),
    description: z.string().optional().describe('File description'),
  },
  async ({ name, mimeType, parents, description }) => {
    const body: Record<string, unknown> = { name, mimeType }
    if (parents) body.parents = parents
    if (description) body.description = description
    const result = await gws(['drive', 'files', 'create', '--json', JSON.stringify(body)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── COPY FILE ───

server.tool(
  'copy_file',
  'Copy a file in Google Drive.',
  {
    fileId: z.string().describe('The file ID to copy'),
    name: z.string().optional().describe('Name for the copy (defaults to "Copy of [original]")'),
    parents: z.array(z.string()).optional().describe('Parent folder IDs for the copy'),
  },
  async ({ fileId, name, parents }) => {
    const body: Record<string, unknown> = {}
    if (name) body.name = name
    if (parents) body.parents = parents
    const result = await gws([
      'drive', 'files', 'copy',
      '--params', JSON.stringify({ fileId }),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE FILE ───

server.tool(
  'update_file',
  'Update file metadata in Google Drive (name, description, etc.).',
  {
    fileId: z.string().describe('The file ID to update'),
    name: z.string().optional().describe('New file name'),
    description: z.string().optional().describe('New file description'),
    mimeType: z.string().optional().describe('New MIME type'),
    addParents: z.string().optional().describe('Comma-separated parent folder IDs to add'),
    removeParents: z.string().optional().describe('Comma-separated parent folder IDs to remove'),
    starred: z.boolean().optional().describe('Star or unstar the file'),
    trashed: z.boolean().optional().describe('Move to or restore from trash'),
  },
  async ({ fileId, name, description, mimeType, addParents, removeParents, starred, trashed }) => {
    const body: Record<string, unknown> = {}
    if (name) body.name = name
    if (description !== undefined) body.description = description
    if (mimeType) body.mimeType = mimeType
    if (starred !== undefined) body.starred = starred
    if (trashed !== undefined) body.trashed = trashed
    const params: Record<string, unknown> = { fileId }
    if (addParents) params.addParents = addParents
    if (removeParents) params.removeParents = removeParents
    if (Object.keys(body).length === 0 && !addParents && !removeParents) {
      throw new Error('At least one field to update is required')
    }
    const result = await gws([
      'drive', 'files', 'update',
      '--params', JSON.stringify(params),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE FILE ───

server.tool(
  'delete_file',
  'Permanently delete a file from Google Drive (bypasses trash).',
  {
    fileId: z.string().describe('The file ID to delete'),
  },
  async ({ fileId }) => {
    const result = await gws(['drive', 'files', 'delete', '--params', JSON.stringify({ fileId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── EXPORT FILE ───

server.tool(
  'export_file',
  'Export a Google Workspace document to a different format (e.g. export a Google Doc as PDF).',
  {
    fileId: z.string().describe('The file ID to export'),
    mimeType: z.string().describe('Target MIME type (e.g. "application/pdf", "text/plain", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")'),
  },
  async ({ fileId, mimeType }) => {
    const result = await gws(['drive', 'files', 'export', '--params', JSON.stringify({ fileId, mimeType })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST PERMISSIONS ───

server.tool(
  'list_permissions',
  'List who has access to a file and their permission levels.',
  {
    fileId: z.string().describe('The file ID'),
    fields: z.string().optional().describe('Fields to return (e.g. "permissions(id,emailAddress,role,type)")'),
  },
  async ({ fileId, fields }) => {
    const params: Record<string, unknown> = { fileId }
    if (fields) params.fields = fields
    const result = await gws(['drive', 'permissions', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SHARE FILE ───

server.tool(
  'share_file',
  'Share a file with a user, group, domain, or make it public.',
  {
    fileId: z.string().describe('The file ID to share'),
    role: z.enum(['owner', 'organizer', 'fileOrganizer', 'writer', 'commenter', 'reader']).describe('Permission role'),
    type: z.enum(['user', 'group', 'domain', 'anyone']).describe('Type of grantee'),
    emailAddress: z.string().optional().describe('Email address (required for user/group type)'),
    domain: z.string().optional().describe('Domain (required for domain type)'),
    sendNotificationEmail: z.boolean().optional().describe('Send a notification email to the grantee'),
  },
  async ({ fileId, role, type, emailAddress, domain, sendNotificationEmail }) => {
    if ((type === 'user' || type === 'group') && !emailAddress) {
      throw new Error('emailAddress is required for user/group type')
    }
    if (type === 'domain' && !domain) {
      throw new Error('domain is required for domain type')
    }
    const body: Record<string, unknown> = { role, type }
    if (emailAddress) body.emailAddress = emailAddress
    if (domain) body.domain = domain
    const params: Record<string, unknown> = { fileId }
    if (sendNotificationEmail !== undefined) params.sendNotificationEmail = sendNotificationEmail
    const result = await gws([
      'drive', 'permissions', 'create',
      '--params', JSON.stringify(params),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST COMMENTS ───

server.tool(
  'list_comments',
  'List comments on a file.',
  {
    fileId: z.string().describe('The file ID'),
    pageSize: z.number().optional().describe('Maximum number of comments to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
    fields: z.string().default('*').describe('Fields to return'),
  },
  async ({ fileId, pageSize, pageToken, fields }) => {
    const params: Record<string, unknown> = { fileId, fields }
    if (pageSize !== undefined) params.pageSize = pageSize
    if (pageToken) params.pageToken = pageToken
    const result = await gws(['drive', 'comments', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── ADD COMMENT ───

server.tool(
  'add_comment',
  'Add a comment to a file.',
  {
    fileId: z.string().describe('The file ID to comment on'),
    content: z.string().describe('Comment text'),
  },
  async ({ fileId, content }) => {
    const result = await gws([
      'drive', 'comments', 'create',
      '--params', JSON.stringify({ fileId }),
      '--json', JSON.stringify({ content }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

const DISCOVERY_URL = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'
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
  'Look up the Google Drive API schema from the live Discovery Service. Browse available resources and data types.',
  {
    resource: z.string().optional().describe('Resource/schema name to look up (e.g. "File", "Permission", "Comment", "Reply"). Leave empty to list all available schemas.'),
  },
  async ({ resource }) => {
    try {
      const discovery = await getDiscovery()
      const schemas = discovery.schemas || {}

      if (!resource) {
        const types = Object.entries(schemas).map(([name, val]: [string, any]) => {
          return `- **${name}**: ${val.description || ''}`
        })
        return { content: [{ type: 'text' as const, text: `# Available Drive API schemas (${types.length})\n\n${types.join('\n')}` }] }
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

// ─── GET PERMISSION ───

server.tool(
  'get_permission',
  'Get details of a specific permission on a file.',
  {
    fileId: z.string().describe('The file ID'),
    permissionId: z.string().describe('The permission ID'),
  },
  async ({ fileId, permissionId }) => {
    const result = await gws(['drive', 'permissions', 'get', '--params', JSON.stringify({ fileId, permissionId, fields: '*' })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE PERMISSION ───

server.tool(
  'update_permission',
  'Update a permission (e.g. change role from viewer to editor).',
  {
    fileId: z.string().describe('The file ID'),
    permissionId: z.string().describe('The permission ID'),
    role: z.enum(['owner', 'organizer', 'fileOrganizer', 'writer', 'commenter', 'reader']).describe('New role'),
  },
  async ({ fileId, permissionId, role }) => {
    const result = await gws([
      'drive', 'permissions', 'update',
      '--params', JSON.stringify({ fileId, permissionId }),
      '--json', JSON.stringify({ role }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE PERMISSION ───

server.tool(
  'delete_permission',
  'Remove a permission (revoke access) from a file.',
  {
    fileId: z.string().describe('The file ID'),
    permissionId: z.string().describe('The permission ID'),
  },
  async ({ fileId, permissionId }) => {
    const result = await gws(['drive', 'permissions', 'delete', '--params', JSON.stringify({ fileId, permissionId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE COMMENT ───

server.tool(
  'update_comment',
  'Update the text of a comment.',
  {
    fileId: z.string().describe('The file ID'),
    commentId: z.string().describe('The comment ID'),
    content: z.string().describe('Updated comment text'),
  },
  async ({ fileId, commentId, content }) => {
    const result = await gws([
      'drive', 'comments', 'update',
      '--params', JSON.stringify({ fileId, commentId }),
      '--json', JSON.stringify({ content }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE COMMENT ───

server.tool(
  'delete_comment',
  'Delete a comment from a file.',
  {
    fileId: z.string().describe('The file ID'),
    commentId: z.string().describe('The comment ID'),
  },
  async ({ fileId, commentId }) => {
    const result = await gws(['drive', 'comments', 'delete', '--params', JSON.stringify({ fileId, commentId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── ABOUT (user/storage info) ───

server.tool(
  'about',
  'Get information about the user and their Drive: storage quota, email, display name.',
  {},
  async () => {
    const result = await gws(['drive', 'about', 'get', '--params', JSON.stringify({ fields: 'user,storageQuota,kind' })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE FOLDER ───

server.tool(
  'create_folder',
  'Create a new folder in Drive.',
  {
    name: z.string().describe('Folder name'),
    parentId: z.string().optional().describe('Parent folder ID. Omit for root.'),
  },
  async ({ name, parentId }) => {
    const body: Record<string, unknown> = { name, mimeType: 'application/vnd.google-apps.folder' }
    if (parentId) body.parents = [parentId]
    const result = await gws(['drive', 'files', 'create', '--json', JSON.stringify(body)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── MOVE FILE ───

server.tool(
  'move_file',
  'Move a file to a different folder.',
  {
    fileId: z.string().describe('The file ID to move'),
    newParentId: z.string().describe('The destination folder ID'),
    removeFromCurrent: z.boolean().default(true).describe('Remove from current parent folder'),
  },
  async ({ fileId, newParentId, removeFromCurrent }) => {
    const params: Record<string, unknown> = { fileId, addParents: newParentId }
    if (removeFromCurrent) {
      // Get current parents first
      const getResult = await gws(['drive', 'files', 'get', '--params', JSON.stringify({ fileId, fields: 'parents' })])
      try {
        const file = JSON.parse(getResult)
        if (file.parents?.length) params.removeParents = file.parents.join(',')
      } catch {}
    }
    const result = await gws(['drive', 'files', 'update', '--params', JSON.stringify(params), '--json', '{}'])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST REVISIONS ───

server.tool(
  'list_revisions',
  'List the revision history of a file. Shows who changed what and when.',
  {
    fileId: z.string().describe('The file ID'),
    pageSize: z.number().default(10).describe('Maximum revisions to return'),
  },
  async ({ fileId, pageSize }) => {
    const result = await gws(['drive', 'revisions', 'list', '--params', JSON.stringify({ fileId, pageSize, fields: '*' })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── EMPTY TRASH ───

server.tool(
  'empty_trash',
  'Permanently delete all files in the user\'s trash. Cannot be undone.',
  {},
  async () => {
    const result = await gws(['drive', 'files', 'emptyTrash'])
    return { content: [{ type: 'text' as const, text: result || 'Trash emptied successfully' }] }
  },
)

// ─── CUSTOM API CALL ───

server.tool(
  'run_api_call',
  'Run a custom gws drive API call for operations not covered by other tools.',
  {
    args: z.array(z.string()).describe('gws command arguments after "drive", e.g. ["files", "list", "--params", "{}"]'),
  },
  async ({ args }) => {
    const result = await gws(['drive', ...args])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-drive-mcp] Server started')
}
main().catch((err) => { console.error('[google-drive-mcp] Fatal:', err); process.exit(1) })
