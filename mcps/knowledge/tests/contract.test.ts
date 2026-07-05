import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createBridge } from '../../shared/bridge.js'

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
        pageTitle: body?.pageTitle,
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
      res.end(JSON.stringify({ error: 'bridge exploded' }))
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

async function withKnowledgeClient<T>(baseUrl: string, fn: (client: Client) => Promise<T>) {
  const client = new Client({ name: 'knowledge-contract-test', version: '1.0.0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      OPEN_COWORK_KNOWLEDGE_TOOL_URL: baseUrl,
      OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN: contractToken,
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

const proposal = {
  spaceId: 'space-handbook',
  pageTitle: 'Release checklist',
  summary: 'Document the pre-release smoke test steps.',
  body: [
    { type: 'h', text: 'Release checklist' },
    { type: 'p', text: 'Run the smoke tests before tagging a release.' },
    { type: 'list', items: ['Build all MCPs', 'Run contract tests'] },
    { type: 'callout', text: 'Never skip the contract tests.' },
  ],
  links: [
    { kind: 'thread', label: 'Planning thread', targetId: 'thread-123' },
    { kind: 'task', label: 'Release task' },
  ],
  by: 'Coworker',
}

test('knowledge MCP registers propose_knowledge_edit with the expected schema', async () => {
  await withBridge(async (baseUrl) => {
    await withKnowledgeClient(baseUrl, async (client) => {
      const listed = await client.listTools()
      assert.deepEqual(listed.tools.map((tool) => tool.name), ['propose_knowledge_edit'])

      const [tool] = listed.tools
      assert.match(tool.description ?? '', /PENDING/, 'tool description should advertise the human-review contract')
      const schema = tool.inputSchema as { properties?: Record<string, unknown>, required?: string[] }
      assert.ok(schema.properties, 'expected an input schema with properties')
      for (const key of ['spaceId', 'pageTitle', 'pageId', 'summary', 'body', 'links', 'by']) {
        assert.ok(schema.properties && key in schema.properties, `expected input schema property ${key}`)
      }
      assert.deepEqual(
        [...(schema.required ?? [])].sort(),
        ['body', 'pageTitle', 'spaceId', 'summary'],
      )
      // Link kinds must stay aligned with KNOWLEDGE_LINK_KINDS in @open-cowork/shared:
      // the bridge rejects anything else, so the advertised enum is part of the contract.
      assert.match(JSON.stringify(schema.properties), /"thread","task","artifact"|"thread", ?"task", ?"artifact"/)
    })
  })
})

test('knowledge MCP routes proposals through the app bridge', async () => {
  await withBridge(async (baseUrl, seen) => {
    await withKnowledgeClient(baseUrl, async (client) => {
      const result = parseTextResult(await client.callTool({ name: 'propose_knowledge_edit', arguments: proposal }))
      assert.equal(result.route, '/propose')
      assert.equal(result.pageTitle, proposal.pageTitle)
    })
    assert.deepEqual(seen.map((entry) => entry.url), ['/propose'])
    const body = seen[0]?.body as Record<string, unknown>
    assert.equal(body.spaceId, proposal.spaceId)
    assert.equal(body.summary, proposal.summary)
    assert.deepEqual(body.body, proposal.body)
    assert.deepEqual(body.links, proposal.links)
  })
})

test('knowledge MCP rejects invalid proposals and surfaces bridge errors', async () => {
  await withBridge(async (baseUrl, seen) => {
    await withKnowledgeClient(baseUrl, async (client) => {
      await assertToolError(client, {
        name: 'propose_knowledge_edit',
        arguments: { spaceId: 'space-handbook', pageTitle: 'Missing body' },
      }, /summary|body/i)
      await assertToolError(client, {
        name: 'propose_knowledge_edit',
        arguments: { ...proposal, body: [] },
      }, /body/i)
      await assertToolError(client, {
        name: 'propose_knowledge_edit',
        arguments: { ...proposal, links: [{ kind: 'page', label: 'Not a valid link kind' }] },
      }, /kind|invalid/i)
    })
    assert.deepEqual(seen, [], 'schema-invalid proposals must never reach the bridge')
  })

  await withFailingBridge(async (baseUrl) => {
    await withKnowledgeClient(baseUrl, async (client) => {
      await assertToolError(client, {
        name: 'propose_knowledge_edit',
        arguments: proposal,
      }, /bridge exploded/)
    })
  })
})

test('knowledge MCP enforces its bridge URL policy end-to-end', async () => {
  // http:// must stay loopback-only even though knowledge allows non-loopback https.
  // 192.0.2.1 is TEST-NET-1, so nothing is ever reachable there; the URL check must
  // reject it before any request is attempted.
  await withKnowledgeClient('http://192.0.2.1:9', async (client) => {
    await assertToolError(client, {
      name: 'propose_knowledge_edit',
      arguments: proposal,
    }, /must point at the local knowledge bridge \(loopback\)/)
  })

  await withKnowledgeClient('ftp://127.0.0.1:21', async (client) => {
    await assertToolError(client, {
      name: 'propose_knowledge_edit',
      arguments: proposal,
    }, /must use http:\/\/ \(local bridge\) or https:\/\/ \(cloud\)/)
  })
})

test('knowledge bridge URL policy allows non-loopback https but the default policy does not', () => {
  const urlEnvVar = 'KNOWLEDGE_CONTRACT_TEST_URL'
  const knowledgePolicy = createBridge({
    urlEnvVar,
    tokenEnvVar: 'KNOWLEDGE_CONTRACT_TEST_TOKEN',
    bridgeName: 'knowledge bridge',
    bridgeLabel: 'Knowledge bridge',
    allowNonLoopbackHttps: true,
  })
  const loopbackOnlyPolicy = createBridge({
    urlEnvVar,
    tokenEnvVar: 'KNOWLEDGE_CONTRACT_TEST_TOKEN',
    bridgeName: 'knowledge bridge',
    bridgeLabel: 'Knowledge bridge',
  })

  try {
    // Cloud runtime: https to a non-loopback host is allowed (and normalised).
    process.env[urlEnvVar] = 'https://cloud.example.com/api/knowledge/agent/'
    assert.equal(knowledgePolicy.bridgeUrl(), 'https://cloud.example.com/api/knowledge/agent')

    // Desktop runtime: http to loopback is allowed.
    process.env[urlEnvVar] = 'http://127.0.0.1:8123/knowledge'
    assert.equal(knowledgePolicy.bridgeUrl(), 'http://127.0.0.1:8123/knowledge')

    // http to a non-loopback host is rejected even under the knowledge policy.
    process.env[urlEnvVar] = 'http://cloud.example.com/api/knowledge/agent'
    assert.throws(() => knowledgePolicy.bridgeUrl(), /must point at the local knowledge bridge \(loopback\)/)

    // Non-http(s) protocols and URL credentials are rejected.
    process.env[urlEnvVar] = 'ftp://127.0.0.1/agent'
    assert.throws(() => knowledgePolicy.bridgeUrl(), /must use http:\/\/ \(local bridge\) or https:\/\/ \(cloud\)/)
    process.env[urlEnvVar] = 'https://user:secret@cloud.example.com/agent'
    assert.throws(() => knowledgePolicy.bridgeUrl(), /must not include URL credentials/)

    // Contrast: the default (loopback-only) policy used by the other bridge MCPs
    // rejects the same https cloud URL outright.
    process.env[urlEnvVar] = 'https://cloud.example.com/api/knowledge/agent'
    assert.throws(() => loopbackOnlyPolicy.bridgeUrl(), /must use http:\/\/ for the local bridge/)
  } finally {
    delete process.env[urlEnvVar]
  }
})
