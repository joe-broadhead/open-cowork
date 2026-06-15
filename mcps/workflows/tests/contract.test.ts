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
        previewToken: req.url === '/preview' ? 'preview-token-from-bridge' : undefined,
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

async function withFailingBridge<T>(fn: (baseUrl: string) => Promise<T>) {
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      assert.equal(req.headers.authorization, `Bearer ${contractToken}`)
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'workflow bridge exploded' }))
    })
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })

  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await fn(`http://127.0.0.1:${address.port}`)
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

async function assertToolError(client: Client, request: Parameters<Client['callTool']>[0], pattern: RegExp) {
  try {
    const result = await client.callTool(request)
    assert.equal('isError' in result ? result.isError : false, true)
    assert.match(JSON.stringify('content' in result ? result.content : result), pattern)
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), pattern)
  }
}

const draft = {
  title: 'Inbox summary',
  instructions: 'Scan the inbox and summarize urgent workload.',
  agentName: 'build',
  skillNames: ['email-triage'],
  toolIds: ['gmail'],
  steps: [
    { id: 'collect', title: 'Collect inbox', detail: 'Find unread urgent items.' },
    { id: 'summarize', title: 'Summarize workload', detail: 'Group by urgency and owner.' },
  ],
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

      const preview = parseTextResult(await client.callTool({ name: 'preview_workflow', arguments: draft }))
      assert.equal(preview.route, '/preview')
      assert.equal(parseTextResult(await client.callTool({
        name: 'create_workflow',
        arguments: { previewToken: preview.previewToken },
      })).route, '/create')
    })
    assert.deepEqual(seen.map((entry) => entry.url), ['/preview', '/create'])
    assert.equal((seen[0]?.body as { title?: string }).title, 'Inbox summary')
    assert.deepEqual((seen[0]?.body as { steps?: unknown }).steps, draft.steps)
    assert.deepEqual(seen[1]?.body, { previewToken: 'preview-token-from-bridge' })
  })
})

test('workflows MCP rejects invalid drafts and surfaces bridge errors', async () => {
  await withBridge(async (baseUrl) => {
    await withWorkflowsClient(baseUrl, async (client) => {
      await assertToolError(client, {
        name: 'preview_workflow',
        arguments: { title: 'Missing instructions', triggers: [] },
      }, /instructions|triggers/i)
    })
  })

  await withFailingBridge(async (baseUrl) => {
    await withWorkflowsClient(baseUrl, async (client) => {
      await assertToolError(client, {
        name: 'create_workflow',
        arguments: { previewToken: 'preview-token-from-bridge' },
      }, /workflow bridge exploded/)
    })
  })
})
