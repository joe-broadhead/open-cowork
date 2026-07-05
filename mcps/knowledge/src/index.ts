import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createBridge } from '../../shared/bridge.js'

const server = new McpServer({
  name: 'knowledge',
  version: '1.0.0',
})

// Must match KNOWLEDGE_LINK_KINDS in @open-cowork/shared (knowledge.ts) — the bridge rejects any
// other kind, so advertising 'page'/'external' produced proposals the store refused while hiding
// the valid 'thread' kind. (Hardcoded rather than imported: the bundled MCP has no shared dep.)
const knowledgeLinkSchema = z.object({
  kind: z.enum(['thread', 'task', 'artifact']).describe('Relationship type for this link.'),
  label: z.string().min(1).describe('Human-readable label for the link target.'),
  targetId: z.string().optional().nullable().describe('Optional id of the linked thread/task/artifact.'),
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

// Unlike the other bridge MCPs, knowledge allows non-loopback https on purpose: the desktop
// runtime points this at a loopback http bridge, while the cloud runtime points it at its own
// https public URL (.../api/knowledge/agent). Both are runtime-set, never agent-set.
const bridge = createBridge<'/propose'>({
  urlEnvVar: 'OPEN_COWORK_KNOWLEDGE_TOOL_URL',
  tokenEnvVar: 'OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN',
  bridgeName: 'knowledge bridge',
  bridgeLabel: 'Knowledge bridge',
  allowNonLoopbackHttps: true,
})

async function postToBridge(path: '/propose', body: ProposeKnowledgeEditInput) {
  return bridge.postToBridge(path, body)
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
