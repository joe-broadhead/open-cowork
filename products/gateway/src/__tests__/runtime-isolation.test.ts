import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { normalizeGatewayEnvironmentConfig, prepareEnvironment, resolveEnvironmentSpec, type EnvironmentSpecInput } from '../environments.js'
import { buildRuntimeIsolationProfile, buildRuntimeLifecycleDiagnostics, runtimeIsolationPromptContext, summarizeRuntimeIsolationProfile, validateRuntimeIsolationSpec } from '../runtime-isolation.js'

describe('runtime isolation profiles', () => {
  it('rejects unsafe or ambiguous environment policies before runtime creation', () => {
    const local = environmentSpec({ name: 'local-net' })
    const container = environmentSpec({ name: 'container-net', backend: 'local-container', container: { image: 'node:22-bookworm-slim' } })
    const wildcard = { ...container, network: { mode: 'restricted' as const, allow: ['*'] } }
    const unenforcedHost = { ...local, network: { mode: 'disabled' as const, allow: [] } }
    const unenforcedAllowlist = { ...container, network: { mode: 'restricted' as const, allow: ['registry.example.test'] } }
    const conflictingContainer = { ...container, network: { mode: 'disabled' as const, allow: [] }, container: { ...container.container, network: 'host' } }
    const root = { ...local, name: 'root-workdir', workdir: path.parse(process.cwd()).root }
    const explicitUnsafe = environmentSpec({ name: 'explicit-unsafe', custom: { unsafeRuntimeIsolation: true } })

    expect(validateRuntimeIsolationSpec(wildcard)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining('wildcard')]) })
    expect(validateRuntimeIsolationSpec(unenforcedHost)).toMatchObject({ ok: true, warnings: [expect.stringContaining('not enforced')] })
    expect(validateRuntimeIsolationSpec(unenforcedAllowlist)).toMatchObject({ ok: false, errors: [expect.stringContaining('no configured enforcement mechanism')] })
    expect(validateRuntimeIsolationSpec(conflictingContainer)).toMatchObject({ ok: false, errors: [expect.stringContaining('conflicts')] })
    expect(validateRuntimeIsolationSpec(root)).toMatchObject({ ok: false, errors: [expect.stringContaining('filesystem root')] })
    expect(validateRuntimeIsolationSpec(explicitUnsafe)).toMatchObject({ ok: false, errors: [expect.stringContaining('explicitly marked unsafe')] })
  })

  it('blocks sensitive local-container host mounts while allowing temp mounts', () => {
    const allowed = environmentSpec({
      name: 'container-temp-mount',
      backend: 'local-container',
      container: {
        image: 'node:22-bookworm-slim',
        mounts: [{ source: os.tmpdir(), target: '/tmp/host-cache', readonly: true }],
      },
    })
    const sensitive = {
      ...allowed,
      name: 'container-sensitive-mount',
      container: {
        ...allowed.container,
        mounts: [{ source: path.join(os.homedir(), '.ssh'), target: '/host-ssh', readonly: true }],
      },
    }

    expect(validateRuntimeIsolationSpec(allowed)).toMatchObject({ ok: true })
    expect(validateRuntimeIsolationSpec(sensitive)).toMatchObject({ ok: false, errors: [expect.stringContaining('sensitive host path')] })
  })

  it('builds a durable redacted profile and projects current cleanup state', () => {
    const homeWorkdir = path.join(os.homedir(), 'opencode-gateway-runtime-secret-path')
    const spec = environmentSpec({
      name: 'node-local',
      workdir: homeWorkdir,
      tools: ['node'],
      env: { GITHUB_TOKEN: 'secret-token-value' },
      secrets: { allow: ['GITHUB_TOKEN'] },
      network: { mode: 'unrestricted' },
    })
    const run = prepareEnvironment(spec, { taskId: 'task_1', stage: 'implement', now: new Date('2026-06-21T10:00:00.000Z') })
    const profile = buildRuntimeIsolationProfile({
      taskId: 'task_1',
      stage: 'implement',
      profileName: 'implementer',
      agentName: 'gateway-implementer',
      model: { providerID: 'openrouter', modelID: 'deepseek/deepseek-v4-pro' },
      profileAccess: { tools: ['bash'], mcpServers: ['linear'], skills: ['gateway-stage'], capabilities: ['review'] },
      environmentSpec: spec,
      environmentRun: run,
      attachmentWorkdir: homeWorkdir,
      reviewGate: {
        active: true,
        deniedTools: ['webfetch'],
        allowedBashCommandCount: 1,
        forbiddenPathHints: ['private notes', path.join(os.homedir(), 'private-notes')],
        changedPermissions: ['bash'],
      },
    })

    expect(profile).toMatchObject({
      validation: { ok: true },
      cwd: { source: 'attachment', redacted: '~/opencode-gateway-runtime-secret-path' },
      filesystem: { policy: 'local-workdir', workdir: '~/opencode-gateway-runtime-secret-path' },
      network: { mode: 'unrestricted' },
      permissions: {
        source: 'review-gate-isolation',
        access: { tools: ['bash'], mcpServers: ['linear'], skills: ['gateway-stage'], capabilities: ['review'] },
        reviewGate: {
          forbiddenPathHints: ['private notes', '~/private-notes'],
        },
      },
      secrets: { allowedNames: ['GITHUB_TOKEN'], count: 1 },
      tools: { required: ['node'], checked: ['node'] },
    })
    expect(JSON.stringify(profile)).not.toContain(os.homedir())
    expect(JSON.stringify(profile)).not.toContain('secret-token-value')
    expect(runtimeIsolationPromptContext(profile)).toContain('Runtime isolation contract:')

    const summary = summarizeRuntimeIsolationProfile(profile, { ...run, status: 'released', cleanup: { ...run.cleanup, state: 'released' } })
    expect(summary?.process.cleanup).toMatchObject({ status: 'released', state: 'released' })
  })

  it('classifies runtime lifecycle failures with redacted operator diagnostics', () => {
    const blockedSpec = environmentSpec({ name: 'missing-tool', tools: ['gateway-tool-missing-for-runtime-test'] })
    const blocked = prepareEnvironment(blockedSpec, { taskId: 'task_blocked', stage: 'implement', now: new Date('2026-06-21T10:00:00.000Z') })
    const now = new Date('2026-06-21T12:00:00.000Z')
    const stale = { ...blocked, id: 'env_stale', status: 'prepared' as const, preflight: { ok: true, checked: [], missing: [], warnings: [], commandRefs: [] }, ttlMs: 1000, updatedAt: '2026-06-21T10:00:00.000Z' }
    const cleanupFailed = {
      ...blocked,
      id: 'env_cleanup_failed',
      status: 'cleanup_failed' as const,
      cleanup: { ...blocked.cleanup, state: 'failed' as const },
      metadata: { cleanupError: `cleanup failed on ${path.join(os.homedir(), 'private-worker-proof.log')} token=secret-token-value chat_id=5102309655 webhook=https://hooks.example.test/private` },
    }
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-runtime-orphan-test-'))
    const workspace = path.join(workspaceRoot, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })
    try {
      const retained = { ...blocked, id: 'env_retained', status: 'retained' as const, ttlMs: 1000, updatedAt: '2026-06-21T10:00:00.000Z' }
      const missingWorkspace = { ...blocked, id: 'env_missing_workspace', status: 'prepared' as const, metadata: { workspaceHostPath: path.join(workspaceRoot, 'missing-workspace') } }
      const missingArtifact = { ...blocked, id: 'env_missing_artifact', status: 'prepared' as const, artifacts: [`file:${path.join(workspaceRoot, 'private-artifact-proof.txt')}`] }
      const custom = { ...blocked, id: 'env_custom', backend: 'custom' as const }
      const abandoned = {
        ...blocked,
        id: 'env_abandoned',
        status: 'released' as const,
        cleanup: { ...blocked.cleanup, state: 'released' as const },
        metadata: { workspaceHostPath: workspace },
      }

      const diagnostics = [
        ...buildRuntimeLifecycleDiagnostics(blocked, { now }),
        ...buildRuntimeLifecycleDiagnostics(stale, { now }),
        ...buildRuntimeLifecycleDiagnostics(cleanupFailed, { now }),
        ...buildRuntimeLifecycleDiagnostics(retained, { now }),
        ...buildRuntimeLifecycleDiagnostics(missingWorkspace, { now }),
        ...buildRuntimeLifecycleDiagnostics(missingArtifact, { now }),
        ...buildRuntimeLifecycleDiagnostics(custom, { now }),
        ...buildRuntimeLifecycleDiagnostics(abandoned, { now }),
      ]

      expect(diagnostics.map(row => row.code)).toEqual(expect.arrayContaining([
        'preflight_blocked',
        'stale_active_environment',
        'cleanup_failed',
        'retained_resource',
        'missing_workspace',
        'missing_artifact',
        'custom_backend_preview',
        'abandoned_workspace',
      ]))
      expect(diagnostics.find(row => row.code === 'cleanup_failed')).toMatchObject({
        severity: 'critical',
        action: expect.stringContaining('rerun cleanup'),
      })
      const serialized = JSON.stringify(diagnostics)
      expect(serialized).not.toContain(os.homedir())
      expect(serialized).not.toContain('private-worker-proof.log')
      expect(serialized).not.toContain('private-artifact-proof.txt')
      expect(serialized).not.toContain('secret-token-value')
      expect(serialized).not.toContain('5102309655')
      expect(serialized).not.toContain('hooks.example.test')
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })
})

function environmentSpec(input: EnvironmentSpecInput) {
  const result = resolveEnvironmentSpec({
    taskEnvironment: input,
    config: normalizeGatewayEnvironmentConfig(),
    stage: 'implement',
    workdir: path.join(os.homedir(), 'repo'),
  })
  if (!result.ok) throw new Error(result.reason)
  return result.spec
}
