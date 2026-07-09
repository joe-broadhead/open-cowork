import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const serverEntry = resolve(packageRoot, 'dist/index.js')
const contractToken = 'contract-token-with-enough-entropy-for-tests'

async function withBridge<T>(fn: (baseUrl: string, seen: string[]) => Promise<T>) {
  const seen: string[] = []
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      seen.push(req.url || '')
      assert.equal(req.headers.authorization, `Bearer ${contractToken}`)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        ok: true,
        route: req.url,
      }))
    })
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })

  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await fn(`http://127.0.0.1:${address.port}`, seen)
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }
}

async function withSemanticUiClient<T>(baseUrl: string, fn: (client: Client) => Promise<T>) {
  const client = new Client({ name: 'semantic-ui-contract-test', version: '1.0.0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      OPEN_COWORK_SEMANTIC_UI_URL: baseUrl,
      OPEN_COWORK_SEMANTIC_UI_TOKEN: contractToken,
    },
    stderr: 'pipe',
  })

  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => {})
  }
}

function parseTextResult(result: Awaited<ReturnType<Client['callTool']>>) {
  assert.equal('isError' in result ? result.isError : false, false)
  assert.ok('content' in result, 'expected MCP tool result content')
  const [first] = result.content
  assert.equal(first?.type, 'text')
  assert.equal(typeof first.text, 'string')
  return JSON.parse(first.text) as Record<string, unknown>
}

test('semantic UI MCP exposes read-only status and snapshot tools over stdio', async () => {
  await withBridge(async (baseUrl, seen) => {
    await withSemanticUiClient(baseUrl, async (client) => {
      const listed = await client.listTools()
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
        'ui_execute_action',
        'ui_list_actions',
        'ui_snapshot',
        'ui_status',
      ])
      assert.equal(parseTextResult(await client.callTool({ name: 'ui_status', arguments: {} })).route, '/status')
      assert.equal(parseTextResult(await client.callTool({ name: 'ui_snapshot', arguments: {} })).route, '/snapshot')
      assert.equal(parseTextResult(await client.callTool({ name: 'ui_list_actions', arguments: {} })).route, '/actions/list')
      assert.equal(parseTextResult(await client.callTool({
        name: 'ui_execute_action',
        arguments: { actionId: 'diagnostics.export' },
      })).route, '/actions/execute')
    })
    assert.deepEqual(seen, ['/status', '/snapshot', '/actions/list', '/actions/execute'])
  })
})
