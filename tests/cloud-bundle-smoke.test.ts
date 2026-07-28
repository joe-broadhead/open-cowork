import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  assertRuntimeExternalResolutionsContained,
  buildSmokeProviderOverride,
  invokeStdioMcpTool,
} from '../scripts/cloud-bundle-smoke-core.mjs'

function writeFixtureFile(root: string, path: string, content: string) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

test('pruned-tree smoke rejects a bundle external that resolves through an ancestor node_modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-cloud-smoke-resolution-'))
  try {
    const runtimeRoot = join(root, 'runtime')
    const bundle = writeFixtureFile(
      runtimeRoot,
      'apps/desktop/dist/cloud/open-cowork-cloud.mjs',
      'export {}\n',
    )
    writeFixtureFile(root, 'node_modules/escaped/package.json', JSON.stringify({
      name: 'escaped',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }))
    writeFixtureFile(root, 'node_modules/escaped/index.js', 'export const escaped = true\n')

    assert.throws(
      () => assertRuntimeExternalResolutionsContained({
        runtimeRoot,
        bundle,
        externalPackages: ['escaped'],
      }),
      /CLOUD_SMOKE_EXTERNAL_ESCAPE.*escaped/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruned-tree smoke accepts externals whose real files stay inside the runtime root', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-cloud-smoke-contained-'))
  try {
    const bundle = writeFixtureFile(
      root,
      'apps/desktop/dist/cloud/open-cowork-cloud.mjs',
      'export {}\n',
    )
    writeFixtureFile(root, 'node_modules/contained/package.json', JSON.stringify({
      name: 'contained',
      version: '1.0.0',
      type: 'module',
      exports: {
        import: './index.js',
      },
    }))
    writeFixtureFile(root, 'node_modules/contained/index.js', 'export const contained = true\n')

    assert.deepEqual(
      assertRuntimeExternalResolutionsContained({
        runtimeRoot: root,
        bundle,
        externalPackages: ['contained'],
      }),
      ['contained'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MCP smoke performs initialize and a real tools/call request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-cloud-smoke-mcp-'))
  try {
    const script = writeFixtureFile(root, 'fixture-mcp.mjs', `
import readline from 'node:readline'
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      },
    }) + '\\n')
  }
  if (request.method === 'tools/call') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({
          type: 'mermaid',
          diagram: request.params.arguments.diagram,
          title: request.params.arguments.title,
        }) }],
      },
    }) + '\\n')
  }
})
`)

    const result = await invokeStdioMcpTool({
      script,
      runtimeRoot: root,
      toolName: 'mermaid',
      arguments: {
        diagram: 'graph TD; A-->B',
        title: 'Cloud closure smoke',
      },
    })
    assert.deepEqual(JSON.parse(result.content[0].text), {
      type: 'mermaid',
      diagram: 'graph TD; A-->B',
      title: 'Cloud closure smoke',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('provider smoke override points OpenRouter at only the deterministic local adapter', () => {
  assert.deepEqual(
    buildSmokeProviderOverride('http://127.0.0.1:41234/v1'),
    {
      cloud: {
        defaultProfile: 'cloud-smoke',
        profiles: {
          'cloud-smoke': {
            label: 'Cloud closure smoke',
            description: 'Deterministic provider adapter closure verification.',
            agents: ['build'],
          },
        },
      },
      providers: {
        available: ['openrouter'],
        defaultProvider: 'openrouter',
        defaultModel: 'cloud-smoke-model',
        descriptors: {
          openrouter: {
            options: {
              baseURL: 'http://127.0.0.1:41234/v1',
            },
            models: [{
              id: 'cloud-smoke-model',
              name: 'Cloud smoke model',
            }],
          },
        },
      },
    },
  )
  assert.throws(
    () => buildSmokeProviderOverride('https://provider.example.test/v1'),
    /loopback HTTP/,
  )
})
