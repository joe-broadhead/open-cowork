import { describe, expect, it } from 'vitest'
import type { PendingApproval } from '@open-cowork/shared'
import {
  classifyPermission,
  describePermission,
  detectRunawayApprovals,
  permissionSignature,
  type RunawaySample,
} from './permission-approval-model'

// Identity translate: returns the English fallback so assertions read against
// the shipped copy without depending on the i18n catalog.
const t = (_key: string, fallback: string, vars?: Record<string, string | number>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name) => (vars && name in vars ? String(vars[name]) : `{{${name}}}`))

function approval(partial: Partial<PendingApproval>): PendingApproval {
  return {
    id: partial.id ?? 'p1',
    sessionId: partial.sessionId ?? 's1',
    tool: partial.tool ?? 'permission',
    input: partial.input ?? {},
    description: partial.description ?? '',
    order: partial.order ?? 0,
    ...partial,
  }
}

describe('classifyPermission', () => {
  it('detects bash from a command input', () => {
    expect(classifyPermission(approval({ tool: 'bash', input: { command: 'ls -la' } }))).toBe('bash')
    expect(classifyPermission(approval({ tool: 'shell', input: {} }))).toBe('bash')
  })

  it('detects file writes from write/edit tools and file inputs', () => {
    expect(classifyPermission(approval({ tool: 'write', input: { filePath: '/a.ts', content: 'x' } }))).toBe('file-write')
    expect(classifyPermission(approval({ tool: 'apply_patch', input: {} }))).toBe('file-write')
  })

  it('separates web fetch from web search', () => {
    expect(classifyPermission(approval({ tool: 'webfetch', input: { url: 'https://x.dev' } }))).toBe('web')
    expect(classifyPermission(approval({ tool: 'websearch', input: { query: 'weather' } }))).toBe('web-search')
  })

  it('detects task delegation and external directories', () => {
    expect(classifyPermission(approval({ tool: 'task', input: { agent: 'builder' } }))).toBe('task')
    expect(classifyPermission(approval({ tool: 'permission', input: {}, taskRunId: 'r1' }))).toBe('task')
    expect(classifyPermission(approval({ tool: 'add_directory', input: { directory: '/etc' } }))).toBe('external-directory')
  })

  it('recognises known integrations and generic MCP tools', () => {
    expect(classifyPermission(approval({ tool: 'gmail_send_email', input: { to: 'a@b.com' } }))).toBe('integration')
    expect(classifyPermission(approval({ tool: 'acme_server_do_thing', input: {} }))).toBe('mcp')
    expect(classifyPermission(approval({ tool: 'mysterytool', input: {} }))).toBe('other')
  })
})

describe('describePermission', () => {
  it('gives bash a contextual title, command metadata, and cwd', () => {
    const descriptor = describePermission(approval({ tool: 'bash', input: { command: 'npm test', cwd: '/repo' } }), t)
    expect(descriptor.kind).toBe('bash')
    expect(descriptor.title).toBe('Run a terminal command')
    expect(descriptor.typeLabel).toBe('Terminal')
    const command = descriptor.metadata.find((field) => field.key === 'command')
    expect(command?.value).toBe('npm test')
    expect(command?.variant).toBe('code')
    expect(descriptor.metadata.find((field) => field.key === 'cwd')?.value).toBe('/repo')
  })

  it('flags destructive shell commands', () => {
    const descriptor = describePermission(approval({ tool: 'bash', input: { command: 'rm -rf /tmp/x' } }), t)
    expect(descriptor.destructive).toBe(true)
    expect(descriptor.title).toBe('Run a destructive command')
  })

  it('lists affected files for a multi-file write', () => {
    const descriptor = describePermission(approval({ tool: 'write', input: { files: ['a.ts', 'b.ts'] } }), t)
    expect(descriptor.title).toBe('Write changes to 2 files')
    const files = descriptor.metadata.find((field) => field.key === 'files')
    expect(files?.variant).toBe('list')
    expect(files?.value).toBe('a.ts\nb.ts')
  })

  it('describes web search with the query', () => {
    const descriptor = describePermission(approval({ tool: 'websearch', input: { query: 'q3 revenue' } }), t)
    expect(descriptor.title).toBe('Search the web')
    expect(descriptor.metadata.find((field) => field.key === 'query')?.value).toBe('q3 revenue')
  })

  it('keeps integration copy for gmail', () => {
    const descriptor = describePermission(approval({ tool: 'gmail_send_email', input: { to: 'a@b.com', subject: 'Hi' } }), t)
    expect(descriptor.title).toBe('Send an email')
    expect(descriptor.metadata.find((field) => field.key === 'detail')?.value).toContain('a@b.com')
  })
})

describe('permissionSignature', () => {
  it('collapses near-identical requests to one signature', () => {
    const a = permissionSignature(approval({ tool: 'bash', input: { command: 'ls  -la' } }))
    const b = permissionSignature(approval({ tool: 'bash', input: { command: 'LS -la' } }))
    expect(a).toBe(b)
  })

  it('distinguishes different commands', () => {
    const a = permissionSignature(approval({ tool: 'bash', input: { command: 'ls' } }))
    const b = permissionSignature(approval({ tool: 'bash', input: { command: 'pwd' } }))
    expect(a).not.toBe(b)
  })
})

describe('detectRunawayApprovals', () => {
  const sig = 'bash:npm test'
  function sample(id: string, at: number, signature = sig): RunawaySample {
    return { id, signature, at }
  }

  it('returns no runaway below threshold', () => {
    const result = detectRunawayApprovals([sample('1', 0), sample('2', 100)], { threshold: 3, windowMs: 10_000 })
    expect(result.runaway).toBe(false)
    expect(result.clusters).toEqual([])
    expect(result.runawayIds).toEqual([])
  })

  it('flags a loop when the same signature repeats within the window', () => {
    const result = detectRunawayApprovals(
      [sample('1', 0), sample('2', 1_000), sample('3', 2_000)],
      { threshold: 3, windowMs: 10_000 },
    )
    expect(result.runaway).toBe(true)
    expect(result.runawaySignatures).toEqual([sig])
    expect(result.runawayIds).toEqual(['1', '2', '3'])
    expect(result.clusters[0]?.count).toBe(3)
  })

  it('does not flag repeats spread beyond the window', () => {
    const result = detectRunawayApprovals(
      [sample('1', 0), sample('2', 30_000), sample('3', 60_000)],
      { threshold: 3, windowMs: 10_000 },
    )
    expect(result.runaway).toBe(false)
  })

  it('flags only the burst inside the window even amid older repeats', () => {
    const result = detectRunawayApprovals(
      [sample('old', 0), sample('1', 100_000), sample('2', 100_500), sample('3', 101_000)],
      { threshold: 3, windowMs: 5_000 },
    )
    expect(result.runaway).toBe(true)
    expect(result.clusters[0]?.ids).toEqual(['1', '2', '3'])
  })

  it('keeps unrelated signatures separate', () => {
    const result = detectRunawayApprovals(
      [sample('1', 0, 'bash:a'), sample('2', 1_000, 'bash:b'), sample('3', 2_000, 'bash:a')],
      { threshold: 3, windowMs: 10_000 },
    )
    expect(result.runaway).toBe(false)
  })

  it('treats windowMs=0 as a pure count over all samples', () => {
    const result = detectRunawayApprovals(
      [sample('1', 0), sample('2', 999_999), sample('3', 5_000_000)],
      { threshold: 3, windowMs: 0 },
    )
    expect(result.runaway).toBe(true)
    expect(result.clusters[0]?.count).toBe(3)
  })

  it('clamps a threshold below 2 up to 2', () => {
    const result = detectRunawayApprovals([sample('1', 0), sample('2', 10)], { threshold: 1, windowMs: 10_000 })
    expect(result.runaway).toBe(true)
  })
})
