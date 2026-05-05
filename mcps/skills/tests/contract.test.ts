import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const serverEntry = resolve(packageRoot, 'dist/index.js')

async function withSkillsClient<T>(fn: (client: Client, skillsRoot: string) => Promise<T>) {
  const skillsRoot = mkdtempSync(resolve(tmpdir(), 'open-cowork-skills-mcp-'))
  const client = new Client({ name: 'skills-contract-test', version: '1.0.0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      OPEN_COWORK_CUSTOM_SKILLS_DIR: skillsRoot,
    },
    stderr: 'pipe',
  })

  await client.connect(transport)
  try {
    return await fn(client, skillsRoot)
  } finally {
    await client.close().catch(() => {})
    rmSync(skillsRoot, { recursive: true, force: true })
  }
}

function parseTextResult(result: Awaited<ReturnType<Client['callTool']>>) {
  assert.equal('isError' in result ? result.isError : false, false)
  assert.ok('content' in result, 'expected MCP tool result content')
  const [first] = result.content
  assert.equal(first?.type, 'text')
  assert.equal(typeof first.text, 'string')
  return JSON.parse(first.text) as unknown
}

test('skills MCP lists, saves, reads, and deletes bundles over stdio', async () => {
  await withSkillsClient(async (client) => {
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['delete_skill_bundle', 'get_skill_bundle', 'list_skill_bundles', 'save_skill_bundle'],
    )

    assert.deepEqual(parseTextResult(await client.callTool({ name: 'list_skill_bundles', arguments: {} })), [])

    const saved = parseTextResult(await client.callTool({
      name: 'save_skill_bundle',
      arguments: {
        name: 'contract-skill',
        skill_md: [
          '---',
          'name: contract-skill',
          'description: Contract test skill.',
          '---',
          '',
          '# Contract Skill',
          '',
          'Use this only for MCP contract tests.',
        ].join('\n'),
        files: [{ path: 'references/example.md', content: '# Example\n\nFixture content.' }],
      },
    })) as { saved?: boolean; bundle?: { name?: string; files?: Array<{ path: string }> } }
    assert.equal(saved.saved, true)
    assert.equal(saved.bundle?.name, 'contract-skill')
    assert.deepEqual(saved.bundle?.files?.map((file) => file.path), ['references/example.md'])

    const listAfterSave = parseTextResult(await client.callTool({ name: 'list_skill_bundles', arguments: {} }))
    assert.deepEqual(listAfterSave, [{ name: 'contract-skill', fileCount: 1 }])

    const bundle = parseTextResult(await client.callTool({
      name: 'get_skill_bundle',
      arguments: { name: 'contract-skill' },
    })) as { name?: string; content?: string; files?: Array<{ path: string; content: string }> }
    assert.equal(bundle.name, 'contract-skill')
    assert.match(bundle.content || '', /Contract Skill/)
    assert.deepEqual(bundle.files, [{ path: 'references/example.md', content: '# Example\n\nFixture content.' }])

    assert.deepEqual(
      parseTextResult(await client.callTool({ name: 'delete_skill_bundle', arguments: { name: 'contract-skill' } })),
      { deleted: true, name: 'contract-skill' },
    )
    assert.deepEqual(parseTextResult(await client.callTool({ name: 'list_skill_bundles', arguments: {} })), [])
  })
})
