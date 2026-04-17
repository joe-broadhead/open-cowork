import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CustomAgentSummary } from '../packages/shared/src/index.ts'
import {
  AGENT_BUNDLE_FORMAT,
  bundleToAgentConfig,
  decodeAgentBundle,
  defaultBundleFilename,
  encodeAgentBundle,
  stringifyAgentBundle,
} from '../apps/desktop/src/renderer/helpers/agent-bundle.ts'

function makeSummary(overrides?: Partial<CustomAgentSummary>): CustomAgentSummary {
  return {
    scope: 'machine',
    directory: null,
    name: 'code-reviewer',
    description: 'Review code diffs and flag risky changes.',
    instructions: 'Work carefully through the diff…',
    skillNames: [],
    toolIds: ['read'],
    enabled: true,
    color: 'accent',
    model: null,
    variant: null,
    temperature: 0.2,
    top_p: null,
    steps: 25,
    options: null,
    avatar: null,
    writeAccess: false,
    valid: true,
    issues: [],
    ...overrides,
  }
}

describe('encodeAgentBundle', () => {
  it('emits a stable cowork-agent-v1 bundle with an exportedAt timestamp', () => {
    const bundle = encodeAgentBundle(makeSummary())
    assert.equal(bundle.format, AGENT_BUNDLE_FORMAT)
    assert.equal(bundle.name, 'code-reviewer')
    assert.deepEqual(bundle.toolIds, ['read'])
    assert.equal(bundle.temperature, 0.2)
    assert.equal(bundle.steps, 25)
    assert.ok(bundle.exportedAt && new Date(bundle.exportedAt).toString() !== 'Invalid Date')
  })

  it('strips install-specific fields (scope/directory/issues/valid) from the emitted bundle', () => {
    const bundle = encodeAgentBundle(
      makeSummary({ scope: 'project', directory: '/tmp/work', issues: [{ code: 'reserved_name', message: 'no' }], valid: false }),
    )
    assert.equal((bundle as Record<string, unknown>).scope, undefined)
    assert.equal((bundle as Record<string, unknown>).directory, undefined)
    assert.equal((bundle as Record<string, unknown>).issues, undefined)
    assert.equal((bundle as Record<string, unknown>).valid, undefined)
  })
})

describe('decodeAgentBundle', () => {
  it('rejects non-object payloads', () => {
    assert.equal(decodeAgentBundle(null).ok, false)
    assert.equal(decodeAgentBundle('hello').ok, false)
    assert.equal(decodeAgentBundle([1, 2, 3]).ok, false)
  })

  it('rejects bundles with a mismatched format string', () => {
    const result = decodeAgentBundle({ format: 'cowork-agent-v2', name: 'x', description: '', instructions: '' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(/Unsupported bundle format/.test(result.error))
  })

  it('rejects bundles missing required string fields', () => {
    const result = decodeAgentBundle({ format: AGENT_BUNDLE_FORMAT, name: '', description: '', instructions: '' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(/name/.test(result.error))
  })

  it('defaults optional fields when a bundle omits them', () => {
    const result = decodeAgentBundle({
      format: AGENT_BUNDLE_FORMAT,
      name: 'writer',
      description: 'Draft prose.',
      instructions: 'Be concrete.',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.bundle.color, 'accent')
    assert.deepEqual(result.bundle.skillNames, [])
    assert.deepEqual(result.bundle.toolIds, [])
    assert.equal(result.bundle.enabled, true)
  })

  it('sanitizes color to a known token', () => {
    const result = decodeAgentBundle({
      format: AGENT_BUNDLE_FORMAT,
      name: 'x',
      description: 'x',
      instructions: 'x',
      color: 'neon-pink',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.bundle.color, 'accent')
  })
})

describe('encode → stringify → decode round-trip', () => {
  it('preserves all user-authored fields through the bundle format', () => {
    const original = makeSummary({
      name: 'researcher',
      description: 'Research on the open web.',
      instructions: 'Cite your sources.',
      skillNames: ['chart-creator'],
      toolIds: ['websearch', 'webfetch'],
      color: 'info',
      temperature: 0.5,
      steps: 40,
      avatar: 'data:image/png;base64,FAKE',
    })
    const encoded = encodeAgentBundle(original)
    const raw = stringifyAgentBundle(encoded)
    const parsed = JSON.parse(raw)
    const decoded = decodeAgentBundle(parsed)
    assert.equal(decoded.ok, true)
    if (!decoded.ok) return
    assert.equal(decoded.bundle.name, 'researcher')
    assert.deepEqual(decoded.bundle.toolIds, ['websearch', 'webfetch'])
    assert.deepEqual(decoded.bundle.skillNames, ['chart-creator'])
    assert.equal(decoded.bundle.color, 'info')
    assert.equal(decoded.bundle.temperature, 0.5)
    assert.equal(decoded.bundle.avatar, 'data:image/png;base64,FAKE')
  })
})

describe('bundleToAgentConfig', () => {
  it('drops directory when target scope is machine', () => {
    const bundle = encodeAgentBundle(makeSummary())
    const config = bundleToAgentConfig(bundle, { scope: 'machine', directory: '/some/project' })
    assert.equal(config.scope, 'machine')
    assert.equal(config.directory, null)
  })

  it('keeps directory when target scope is project', () => {
    const bundle = encodeAgentBundle(makeSummary())
    const config = bundleToAgentConfig(bundle, { scope: 'project', directory: '/some/project' })
    assert.equal(config.scope, 'project')
    assert.equal(config.directory, '/some/project')
  })
})

describe('defaultBundleFilename', () => {
  it('slugifies agent names for a safe filename', () => {
    assert.equal(defaultBundleFilename('Code Reviewer'), 'code-reviewer.cowork-agent.json')
    assert.equal(defaultBundleFilename(' Jurassic Park!! '), 'jurassic-park.cowork-agent.json')
    assert.equal(defaultBundleFilename(''), 'agent.cowork-agent.json')
  })
})
