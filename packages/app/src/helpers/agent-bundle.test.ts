import { describe, expect, it, vi } from 'vitest'
import type { CustomAgentSummary } from '@open-cowork/shared'
import {
  AGENT_BUNDLE_FORMAT,
  bundleToAgentConfig,
  decodeAgentBundle,
  defaultBundleFilename,
  encodeAgentBundle,
  stringifyAgentBundle,
} from './agent-bundle'

function makeAgent(overrides: Partial<CustomAgentSummary> = {}): CustomAgentSummary {
  return {
    scope: 'machine',
    directory: null,
    name: 'data-analyst',
    description: 'Analyze data and summarize findings.',
    instructions: 'Use evidence before recommendations.',
    skillNames: ['analyst'],
    toolIds: ['charts'],
    mode: 'subagent',
    enabled: true,
    color: 'info',
    avatar: 'data:image/png;base64,avatar',
    model: null,
    variant: null,
    temperature: 0.2,
    top_p: null,
    steps: 32,
    options: null,
    writeAccess: false,
    valid: true,
    issues: [],
    ...overrides,
  }
}

describe('agent bundle helpers', () => {
  it('exports a portable bundle without install-specific state', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T12:00:00.000Z'))

    const bundle = encodeAgentBundle(makeAgent({
      scope: 'project',
      directory: '/workspace',
      valid: false,
      issues: [{ code: 'invalid_name', message: 'bad name' }],
    }))

    expect(bundle).toMatchObject({
      format: AGENT_BUNDLE_FORMAT,
      name: 'data-analyst',
      skillNames: ['analyst'],
      toolIds: ['charts'],
      mode: 'subagent',
      exportedAt: '2026-05-09T12:00:00.000Z',
    })
    expect(bundle).not.toHaveProperty('scope')
    expect(bundle).not.toHaveProperty('directory')
    expect(bundle).not.toHaveProperty('issues')
  })

  it('decodes bundles with safe defaults and sanitizes invalid optional values', () => {
    const result = decodeAgentBundle({
      format: AGENT_BUNDLE_FORMAT,
      name: ' imported-agent ',
      description: 'Imported.',
      instructions: 'Run the imported workflow.',
      skillNames: ['analyst', 42],
      toolIds: ['charts', null],
      color: 'neon',
      enabled: false,
      temperature: 'hot',
      options: [],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bundle).toMatchObject({
      name: 'imported-agent',
      skillNames: ['analyst'],
      toolIds: ['charts'],
      color: 'accent',
      enabled: false,
      temperature: null,
      options: null,
    })
  })

  it('returns actionable decode errors for invalid bundle payloads', () => {
    expect(decodeAgentBundle(null)).toMatchObject({ ok: false })
    expect(decodeAgentBundle({ format: 'cowork-agent-v2' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unsupported bundle format'),
    })
    expect(decodeAgentBundle({ format: AGENT_BUNDLE_FORMAT, name: '', description: '', instructions: '' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('name'),
    })
  })

  it('round-trips through JSON and converts imported bundles into scoped agent configs', () => {
    const bundle = encodeAgentBundle(makeAgent({
      mode: 'primary',
      permissionOverrides: [
        { key: 'task', action: 'ask', rules: [{ pattern: 'build', action: 'allow' }] },
      ],
    }))
    const raw = stringifyAgentBundle(bundle)
    expect(raw.endsWith('\n')).toBe(true)

    const decoded = decodeAgentBundle(JSON.parse(raw))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return

    expect(bundleToAgentConfig(decoded.bundle, { scope: 'machine', directory: '/ignored' })).toMatchObject({
      scope: 'machine',
      directory: null,
      name: 'data-analyst',
      mode: 'primary',
      permissionOverrides: [
        { key: 'task', action: 'ask', rules: [{ pattern: 'build', action: 'allow' }] },
      ],
    })
    expect(bundleToAgentConfig(decoded.bundle, { scope: 'project', directory: '/workspace' })).toMatchObject({
      scope: 'project',
      directory: '/workspace',
      skillNames: ['analyst'],
    })
  })

  it('keeps local external-directory permissions out of portable bundles', () => {
    const bundle = encodeAgentBundle(makeAgent({
      permissionOverrides: [
        { key: 'external_directory', action: 'allow', rules: [{ pattern: '/Users/alice/private/*', action: 'allow' }] },
        { key: 'task', action: 'ask', rules: [{ pattern: 'build', action: 'allow' }] },
      ],
    }))

    expect(bundle.permissionOverrides).toEqual([
      { key: 'task', action: 'ask', rules: [{ pattern: 'build', action: 'allow' }] },
    ])

    const decoded = decodeAgentBundle({
      format: AGENT_BUNDLE_FORMAT,
      name: 'imported-agent',
      description: 'Imported.',
      instructions: 'Run the imported workflow.',
      skillNames: [],
      toolIds: [],
      permissionOverrides: [
        { key: 'external_directory', action: 'allow', rules: [{ pattern: '/Users/alice/private/*', action: 'allow' }] },
        { key: 'bash', action: 'ask', rules: [{ pattern: 'pnpm test', action: 'allow' }] },
      ],
    })
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return

    expect(decoded.bundle.permissionOverrides).toEqual([
      { key: 'bash', action: 'ask', rules: [{ pattern: 'pnpm test', action: 'allow' }] },
    ])
    expect(bundleToAgentConfig(decoded.bundle, { scope: 'machine' }).permissionOverrides).toEqual([
      { key: 'bash', action: 'ask', rules: [{ pattern: 'pnpm test', action: 'allow' }] },
    ])
  })

  it('builds safe default filenames from agent names', () => {
    expect(defaultBundleFilename('Data Analyst')).toBe('data-analyst.cowork-agent.json')
    expect(defaultBundleFilename('  $$ Weird Name !! ')).toBe('weird-name.cowork-agent.json')
    expect(defaultBundleFilename('')).toBe('agent.cowork-agent.json')
  })
})
