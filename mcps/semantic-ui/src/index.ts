import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createBridge } from '../../shared/bridge.js'

const server = new McpServer({
  name: 'semantic-ui',
  version: '1.0.0',
})

const { postToBridge } = createBridge<'/status' | '/snapshot' | '/actions/list' | '/actions/execute'>({
  urlEnvVar: 'OPEN_COWORK_SEMANTIC_UI_URL',
  tokenEnvVar: 'OPEN_COWORK_SEMANTIC_UI_TOKEN',
  bridgeName: 'semantic UI bridge',
  bridgeLabel: 'Semantic UI bridge',
  // Interactive UI actions want a snappier abort than the default bridge timeout: keep the
  // original 5s posture so an unresponsive local bridge fails fast instead of hanging 10s.
  timeoutMs: 5_000,
})

function textResult(value: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(value),
    }],
  }
}

server.tool(
  'ui_status',
  'Read Open Cowork app readiness, route, workspace, active session, runtime health, and pending approval/question counts from product-owned state.',
  {},
  async () => textResult(await postToBridge('/status')),
)

server.tool(
  'ui_snapshot',
  'Read a high-level Open Cowork visible-state snapshot from product-owned state. This does not expose DOM selectors, screenshots, hidden secrets, or artifact bodies.',
  {},
  async () => textResult(await postToBridge('/snapshot')),
)

server.tool(
  'ui_list_actions',
  'List allowlisted semantic Open Cowork product actions available through the local bridge for the current state.',
  {},
  async () => textResult(await postToBridge('/actions/list')),
)

server.tool(
  'ui_execute_action',
  'Execute one allowlisted semantic Open Cowork product action through the local bridge. Availability is state-dependent and enforced by the bridge registry.',
  {
    actionId: z.enum([
      'diagnostics.export',
      'approval.allow',
      'approval.deny',
      'question.answer',
      'question.reject',
    ]).describe('The allowlisted semantic action id to execute.'),
    input: z.record(z.string(), z.unknown()).optional().default({}).describe('Optional action input. Approval/question actions require current-state identifiers and may require confirmation.'),
  },
  async (input) => textResult(await postToBridge('/actions/execute', input)),
)

process.stderr.write('[semantic-ui-mcp] Server started\n')
const transport = new StdioServerTransport()
await server.connect(transport)
