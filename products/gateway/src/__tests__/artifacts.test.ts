import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import { getRunArtifactManifestView, listRunArtifactManifestViews, runArtifactManifestPath } from '../artifacts.js'
import { formatArtifactManifestSummary } from '../mcp.js'
import { clearWorkStateForTest, completeWorkTaskRun, createWorkTask, loadWorkState, startWorkTaskRun } from '../work-store.js'

describe('run artifact manifests', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-artifacts-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
    clearWorkStateForTest(store)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  it('writes a bounded local manifest for completed run artifacts and redacts raw refs from read views', () => {
    const artifactPath = path.join(testDir, 'verify-output.log')
    fs.writeFileSync(artifactPath, 'non-sensitive progress\n')
    const task = createWorkTask({ title: 'Artifact handoff', pipeline: ['verify'] }, store)
    const started = startWorkTaskRun(task.id, 'verify', 'ses_artifact_manifest', 'verifier', store)!

    completeWorkTaskRun(started.run.id, {
      status: 'pass',
      summary: 'verified',
      feedback: 'ok',
      artifacts: [`file:${artifactPath}`],
      evidence: [{ type: 'file', ref: `file:${artifactPath}`, summary: 'safe artifact' }],
      raw: 'ok',
    }, 2, store)

    const manifestPath = runArtifactManifestPath(started.run.id, store)
    const state = loadWorkState(store)
    const view = getRunArtifactManifestView(started.run.id, state, store)!
    const text = formatArtifactManifestSummary(view, true)

    expect(fs.existsSync(manifestPath)).toBe(true)
    expect((fs.statSync(manifestPath).mode & 0o777).toString(8)).toBe('600')
    expect(view).toMatchObject({
      runId: started.run.id,
      taskId: task.id,
      stage: 'verify',
      manifestFound: true,
      counts: { available: 1, missing: 0, unsupported: 0, blocked: 0 },
      redactionStatus: 'redacted',
      retentionPolicies: ['run_artifact'],
      workspace: { localOnly: true, hostedCollaboration: false },
    })
    expect(view.entries[0]).toMatchObject({
      status: 'available',
      filename: 'verify-output.log',
      redactionStatus: 'redacted',
      previewSafe: true,
      rawRefAvailable: false,
    })
    expect(JSON.stringify(view)).not.toContain(artifactPath)
    expect(text).not.toContain(artifactPath)
    expect(text).toContain('file:<gateway-artifact:verify-output.log#')
    expect(listRunArtifactManifestViews(state, store, { taskId: task.id })).toHaveLength(1)
  })

  it('degrades gracefully when a manifest artifact is deleted after completion', () => {
    const artifactPath = path.join(testDir, 'deleted-output.log')
    fs.writeFileSync(artifactPath, 'temporary output\n')
    const task = createWorkTask({ title: 'Deleted artifact', pipeline: ['verify'] }, store)
    const started = startWorkTaskRun(task.id, 'verify', 'ses_deleted_artifact', 'verifier', store)!
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'done', feedback: '', artifacts: [`file:${artifactPath}`], raw: 'done' }, 2, store)

    fs.unlinkSync(artifactPath)

    const view = getRunArtifactManifestView(started.run.id, loadWorkState(store), store)!
    expect(view.counts).toMatchObject({ available: 0, missing: 1 })
    expect(view.entries[0]).toMatchObject({ status: 'missing', previewSafe: false, omittedReason: 'file not found' })
  })

  it('marks oversized artifacts as available but not preview safe', () => {
    const artifactPath = path.join(testDir, 'large-output.log')
    fs.writeFileSync(artifactPath, Buffer.alloc((2 * 1024 * 1024) + 1, 'x'))
    const task = createWorkTask({ title: 'Large artifact', pipeline: ['verify'] }, store)
    const started = startWorkTaskRun(task.id, 'verify', 'ses_large_artifact', 'verifier', store)!
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'done', feedback: '', artifacts: [`file:${artifactPath}`], raw: 'done' }, 2, store)

    const view = getRunArtifactManifestView(started.run.id, loadWorkState(store), store)!
    expect(view.entries[0]).toMatchObject({
      status: 'available',
      redactionStatus: 'blocked',
      previewSafe: false,
      omittedReason: 'artifact exceeds inline view limit',
    })
    expect(view.entries[0]!.sha256).toBeUndefined()
  })

  it('keeps non-file refs as metadata-only unsupported entries', () => {
    const task = createWorkTask({ title: 'Remote artifact ref', pipeline: ['verify'] }, store)
    const started = startWorkTaskRun(task.id, 'verify', 'ses_remote_artifact', 'verifier', store)!
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'done', feedback: '', artifacts: ['artifact://remote-proof'], raw: 'done' }, 2, store)

    const view = getRunArtifactManifestView(started.run.id, loadWorkState(store), store)!
    expect(view.entries[0]).toMatchObject({
      status: 'unsupported',
      redactionStatus: 'not_applicable',
      retentionPolicy: 'external_reference',
      omittedReason: 'non-file artifact ref is retained as metadata only',
    })
  })

  it('omits manifests for completed runs without artifact refs', () => {
    const task = createWorkTask({ title: 'No artifact run', pipeline: ['verify'] }, store)
    const started = startWorkTaskRun(task.id, 'verify', 'ses_no_artifact', 'verifier', store)!
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'done', feedback: '', artifacts: [], raw: 'done' }, 2, store)

    expect(fs.existsSync(runArtifactManifestPath(started.run.id, store))).toBe(false)
    expect(getRunArtifactManifestView(started.run.id, loadWorkState(store), store)).toMatchObject({
      manifestFound: false,
      counts: { available: 0, missing: 0, unsupported: 0, blocked: 0 },
      entries: [],
    })
    expect(listRunArtifactManifestViews(loadWorkState(store), store, { taskId: task.id })).toEqual([])
  })
})
