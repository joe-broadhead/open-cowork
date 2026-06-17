import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'knowledge',
  version: '1.0.0',
})

const BRIDGE_REQUEST_TIMEOUT_MS = 10_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const knowledgeLinkSchema = z.object({
  kind: z.enum(['page', 'task', 'artifact', 'external']).describe('Relationship type for this link.'),
  label: z.string().min(1).describe('Human-readable label for the link target.'),
  targetId: z.string().optional().nullable().describe('Optional id of the linked page/task/artifact.'),
})

const knowledgeBlockSchema = z.union([
  z.object({
    id: z.string().optional().describe('Stable block id; omit to let Open Cowork generate one.'),
    type: z.enum(['p', 'h', 'callout']).describe('Paragraph, heading, or callout block.'),
    text: z.string().min(1).describe('Block text content.'),
  }),
  z.object({
    id: z.string().optional().describe('Stable block id; omit to let Open Cowork generate one.'),
    type: z.literal('list').describe('Bulleted list block.'),
    items: z.array(z.string().min(1)).min(1).describe('Non-empty list items.'),
  }),
])

// A coworker proposes the page body as structured blocks. Each proposal stays
// PENDING until a human Maintainer reviews it — the coworker never publishes a
// page version directly.
const proposeKnowledgeEditShape = {
  spaceId: z.string().min(1).describe('Knowledge Space id the proposed page belongs to.'),
  pageTitle: z.string().min(1).describe('Title of the page to create or update.'),
  pageId: z.string().optional().nullable().describe('Existing page id to update; omit to match by title or create a new page.'),
  summary: z.string().min(1).describe('Short human-readable summary of what this proposal changes and why.'),
  body: z.array(knowledgeBlockSchema).min(1).describe('Proposed page body as ordered blocks (paragraphs, headings, callouts, lists).'),
  links: z.array(knowledgeLinkSchema).optional().describe('Optional related links to pages, tasks, or artifacts.'),
  by: z.string().optional().nullable().describe('Display name of the proposing coworker; defaults to Coworker.'),
}

type ProposeKnowledgeEditInput = z.infer<z.ZodObject<typeof proposeKnowledgeEditShape>>

function bridgeUrl() {
  const value = process.env.OPEN_COWORK_KNOWLEDGE_TOOL_URL?.trim()
  if (!value) throw new Error('OPEN_COWORK_KNOWLEDGE_TOOL_URL is not configured.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('OPEN_COWORK_KNOWLEDGE_TOOL_URL must be a valid URL.')
  }
  if (url.protocol !== 'http:') {
    throw new Error('OPEN_COWORK_KNOWLEDGE_TOOL_URL must use http:// for the local bridge.')
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('OPEN_COWORK_KNOWLEDGE_TOOL_URL must point at the local knowledge bridge.')
  }
  if (url.username || url.password) {
    throw new Error('OPEN_COWORK_KNOWLEDGE_TOOL_URL must not include URL credentials.')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function bridgeToken() {
  const value = process.env.OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN?.trim()
  if (!value) throw new Error('OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN is not configured.')
  if (value.length < 32) throw new Error('OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN is invalid.')
  return value
}

async function postToBridge(path: '/propose', body: ProposeKnowledgeEditInput) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BRIDGE_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${bridgeUrl()}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridgeToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Knowledge bridge request timed out.', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { ok: false, error: text || 'Knowledge bridge returned invalid JSON.' }
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error?: unknown }).error)
      : `Knowledge bridge returned HTTP ${response.status}.`
    throw new Error(error)
  }
  return parsed
}

function textResult(value: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(value),
    }],
  }
}

server.tool(
  'propose_knowledge_edit',
  'Propose an edit to the Open Cowork knowledge wiki. The proposal is saved as PENDING and a human Maintainer must review it before any page version is published — coworkers never publish directly. Returns the created proposal (id, summary, diff stats) for confirmation.',
  proposeKnowledgeEditShape,
  async (proposal) => textResult(await postToBridge('/propose', proposal)),
)

process.stderr.write('[knowledge-mcp] Server started\n')
const transport = new StdioServerTransport()
await server.connect(transport)
