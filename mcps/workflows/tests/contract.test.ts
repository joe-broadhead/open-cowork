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

async function withBridge<T>(fn: (baseUrl: string, seen: Array<{ url: string; body: unknown }>) => Promise<T>) {
  const seen: Array<{ url: string; body: unknown }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : null
      seen.push({ url: req.url || '', body })
      assert.equal(req.headers.authorization, `Bearer ${contractToken}`)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        ok: true,
        route: req.url,
        title: body?.title,
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

async function withWorkflowsClient<T>(baseUrl: string, fn: (client: Client) => Promise<T>) {
  const client = new Client({ name: 'workflows-contract-test', version: '1.0.0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      OPEN_COWORK_WORKFLOW_TOOL_URL: baseUrl,
      OPEN_COWORK_WORKFLOW_TOOL_TOKEN: contractToken,
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

const draft = {
  title: 'Inbox summary',
  instructions: 'Scan the inbox and summarize urgent workload.',
  agentName: 'build',
  skillNames: ['email-triage'],
  toolIds: ['gmail'],
  triggers: [
    { type: 'manual', enabled: true },
    { type: 'webhook', enabled: true },
  ],
}

test('workflows MCP previews and creates through the app bridge', async () => {
  await withBridge(async (baseUrl, seen) => {
    await withWorkflowsClient(baseUrl, async (client) => {
      const listed = await client.listTools()
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['create_workflow', 'preview_workflow'])

      assert.equal(parseTextResult(await client.callTool({ name: 'preview_workflow', arguments: draft })).route, '/preview')
      assert.equal(parseTextResult(await client.callTool({ name: 'create_workflow', arguments: draft })).route, '/create')
    })
    assert.deepEqual(seen.map((entry) => entry.url), ['/preview', '/create'])
    assert.equal((seen[0]?.body as { title?: string }).title, 'Inbox summary')
  })
})
