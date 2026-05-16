import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerAdvancedChartTools } from './advanced-tools.js'
import { registerBasicChartTools } from './basic-tools.js'

const server = new McpServer({
  name: 'charts',
  version: '1.0.0',
})

registerBasicChartTools(server)
registerAdvancedChartTools(server)

process.stderr.write('[charts-mcp] Server started\n')
const transport = new StdioServerTransport()
await server.connect(transport)
