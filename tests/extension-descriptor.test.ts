import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  CustomAgentConfig,
  CustomMcpConfig,
  CustomSkillConfig,
} from '@open-cowork/shared'
import {
  EXTENSION_REDACTED_PLACEHOLDER,
  agentToExtensionDescriptor,
  extensionDescriptorToAgent,
  extensionDescriptorToMcp,
  extensionDescriptorToSkill,
  mcpToExtensionDescriptor,
  providerToExtensionDescriptor,
  skillToExtensionDescriptor,
  unsatisfiedSecrets,
} from '@open-cowork/shared'

function httpMcp(overrides?: Partial<CustomMcpConfig>): CustomMcpConfig {
  return {
    scope: 'machine',
    directory: null,
    name: 'tickets',
    label: 'Tickets',
    description: 'Internal ticket tools.',
    type: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer super-secret-token', 'X-Trace': 'plain' },
    allowPrivateNetwork: true,
    ...overrides,
  }
}

function stdioMcp(overrides?: Partial<CustomMcpConfig>): CustomMcpConfig {
  return {
    scope: 'machine',
    directory: null,
    name: 'crm',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@acme/crm-mcp', '--db', '/Users/alice/secret/crm.db'],
    env: { CRM_API_KEY: 'sk-live-123', CRM_REGION: 'us' },
    ...overrides,
  }
}

describe('mcpToExtensionDescriptor redaction', () => {
  it('redacts header values and records them as required secrets', () => {
    const descriptor = mcpToExtensionDescriptor(httpMcp())
    assert.equal(descriptor.kind, 'mcp')
    assert.equal(descriptor.id, 'mcp:tickets')
    assert.equal(descriptor.payload.kind, 'mcp')
    if (descriptor.payload.kind !== 'mcp') throw new Error('unreachable')
    // No raw secret survives anywhere in the serialized descriptor.
    const serialized = JSON.stringify(descriptor)
    assert.equal(serialized.includes('super-secret-token'), false)
    assert.equal(descriptor.payload.mcp.headers?.Authorization, EXTENSION_REDACTED_PLACEHOLDER)
    assert.equal(descriptor.payload.mcp.headers?.['X-Trace'], EXTENSION_REDACTED_PLACEHOLDER)
    const keys = descriptor.secrets.map((s) => s.key).sort()
    assert.deepEqual(keys, ['header:Authorization', 'header:X-Trace'])
    assert.ok(descriptor.secrets.every((s) => s.location === 'header' && s.required))
  })

  it('redacts env values and absolute-path args for stdio MCPs', () => {
    const descriptor = mcpToExtensionDescriptor(stdioMcp())
    if (descriptor.payload.kind !== 'mcp') throw new Error('unreachable')
    const serialized = JSON.stringify(descriptor)
    assert.equal(serialized.includes('sk-live-123'), false)
    assert.equal(serialized.includes('/Users/alice/secret/crm.db'), false)
    // Relative launcher + flags stay intact; only the absolute path is redacted.
    assert.deepEqual(descriptor.payload.mcp.args, ['-y', '@acme/crm-mcp', '--db', EXTENSION_REDACTED_PLACEHOLDER])
    assert.equal(descriptor.payload.mcp.command, 'npx')
    assert.equal(descriptor.payload.mcp.env?.CRM_API_KEY, EXTENSION_REDACTED_PLACEHOLDER)
    assert.equal(descriptor.payload.mcp.env?.CRM_REGION, EXTENSION_REDACTED_PLACEHOLDER)
    const keys = descriptor.secrets.map((s) => s.key).sort()
    assert.deepEqual(keys, ['env:CRM_API_KEY', 'env:CRM_REGION', 'path:arg:3'])
  })

  it('redacts an absolute command path', () => {
    const descriptor = mcpToExtensionDescriptor(stdioMcp({ command: '/opt/bin/crm', args: [] }))
    if (descriptor.payload.kind !== 'mcp') throw new Error('unreachable')
    assert.equal(descriptor.payload.mcp.command, EXTENSION_REDACTED_PLACEHOLDER)
    assert.ok(descriptor.secrets.some((s) => s.key === 'path:command' && s.location === 'path'))
  })
})

describe('MCP descriptor round-trip', () => {
  it('reconstructs a remote MCP with supplied header secrets', () => {
    const descriptor = mcpToExtensionDescriptor(httpMcp())
    const mcp = extensionDescriptorToMcp(descriptor, { scope: 'machine' }, {
      'header:Authorization': 'Bearer restored',
      'header:X-Trace': 'restored-trace',
    })
    assert.equal(mcp.type, 'http')
    assert.equal(mcp.url, 'https://example.com/mcp')
    assert.equal(mcp.headers?.Authorization, 'Bearer restored')
    assert.equal(mcp.headers?.['X-Trace'], 'restored-trace')
    assert.equal(mcp.allowPrivateNetwork, true)
    assert.equal(mcp.scope, 'machine')
  })

  it('leaves the placeholder when a secret is not supplied', () => {
    const descriptor = mcpToExtensionDescriptor(stdioMcp())
    const mcp = extensionDescriptorToMcp(descriptor, { scope: 'machine' }, { 'env:CRM_API_KEY': 'restored' })
    assert.equal(mcp.env?.CRM_API_KEY, 'restored')
    // Not supplied → placeholder remains (never invented).
    assert.equal(mcp.env?.CRM_REGION, EXTENSION_REDACTED_PLACEHOLDER)
    assert.equal(mcp.args?.[3], EXTENSION_REDACTED_PLACEHOLDER)
  })

  it('maps project scope + directory onto the reconstructed record', () => {
    const descriptor = mcpToExtensionDescriptor(httpMcp())
    const mcp = extensionDescriptorToMcp(descriptor, { scope: 'project', directory: '/work/repo' }, {
      'header:Authorization': 'x',
      'header:X-Trace': 'y',
    })
    assert.equal(mcp.scope, 'project')
    assert.equal(mcp.directory, '/work/repo')
  })
})

describe('unsatisfiedSecrets', () => {
  it('reports required secrets that are still missing', () => {
    const descriptor = mcpToExtensionDescriptor(httpMcp())
    assert.equal(unsatisfiedSecrets(descriptor, {}).length, 2)
    assert.equal(unsatisfiedSecrets(descriptor, { 'header:Authorization': 'x' }).length, 1)
    assert.equal(unsatisfiedSecrets(descriptor, {
      'header:Authorization': 'x',
      'header:X-Trace': 'y',
    }).length, 0)
  })

  it('treats a placeholder value as still missing', () => {
    const descriptor = mcpToExtensionDescriptor(httpMcp())
    assert.equal(unsatisfiedSecrets(descriptor, {
      'header:Authorization': EXTENSION_REDACTED_PLACEHOLDER,
      'header:X-Trace': 'y',
    }).length, 1)
  })
})

describe('skill descriptor round-trip', () => {
  const skill: CustomSkillConfig = {
    scope: 'machine',
    directory: null,
    name: 'reports',
    content: '---\nname: reports\n---\nDo reports.',
    files: [{ path: 'ref.md', content: 'ref' }],
    toolIds: ['read'],
  }

  it('carries content, files, and toolIds with no secrets', () => {
    const descriptor = skillToExtensionDescriptor(skill)
    assert.equal(descriptor.kind, 'skill')
    assert.equal(descriptor.secrets.length, 0)
    const restored = extensionDescriptorToSkill(descriptor, { scope: 'machine' })
    assert.deepEqual(restored.files, skill.files)
    assert.deepEqual(restored.toolIds, skill.toolIds)
    assert.equal(restored.content, skill.content)
  })
})

describe('agent descriptor round-trip', () => {
  const agent: CustomAgentConfig = {
    scope: 'project',
    directory: '/work/repo',
    name: 'code-reviewer',
    description: 'Reviews diffs.',
    instructions: 'Be careful.',
    skillNames: ['reports'],
    toolIds: ['read'],
    mode: 'subagent',
    enabled: true,
    color: 'accent',
    avatar: null,
    model: 'anthropic/claude',
    variant: null,
    temperature: 0.2,
    top_p: null,
    steps: 25,
    options: null,
  }

  it('preserves referenced skills/tools and resets scope on import', () => {
    const descriptor = agentToExtensionDescriptor(agent)
    assert.equal(descriptor.kind, 'agent')
    assert.equal(descriptor.secrets.length, 0)
    const restored = extensionDescriptorToAgent(descriptor, { scope: 'machine' })
    assert.equal(restored.scope, 'machine')
    assert.equal(restored.directory, null)
    assert.deepEqual(restored.skillNames, ['reports'])
    assert.deepEqual(restored.toolIds, ['read'])
    assert.equal(restored.temperature, 0.2)
    assert.equal(restored.steps, 25)
    assert.equal(restored.model, 'anthropic/claude')
  })
})

describe('provider descriptor redaction', () => {
  it('strips credential-like option values but keeps shape', () => {
    const descriptor = providerToExtensionDescriptor({
      id: 'example-gateway',
      runtime: 'custom',
      name: 'Example Gateway',
      defaultModel: 'big',
      options: { baseURL: 'https://llm.example.com', apiKey: 'sk-secret', authToken: 'tok' },
    })
    assert.equal(descriptor.kind, 'provider')
    if (descriptor.payload.kind !== 'provider') throw new Error('unreachable')
    const serialized = JSON.stringify(descriptor)
    assert.equal(serialized.includes('sk-secret'), false)
    assert.equal(serialized.includes('"tok"'), false)
    assert.equal(descriptor.payload.provider.options?.baseURL, 'https://llm.example.com')
    assert.equal(descriptor.payload.provider.options?.apiKey, EXTENSION_REDACTED_PLACEHOLDER)
    const keys = descriptor.secrets.map((s) => s.key).sort()
    assert.deepEqual(keys, ['credential:apiKey', 'credential:authToken'])
  })
})
