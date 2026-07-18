import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { buildEvidenceBundle, writeEvidenceBundle } from '../evidence-export.js'
import {
  appendWorkEvent,
  clearWorkStateForTest,
  completeWorkTaskRun,
  createRoadmap,
  createWorkTask,
  startWorkTaskRun,
  upsertChannelBinding,
  upsertProjectBinding,
} from '../work-store.js'

describe('evidence exporter', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-evidence-export-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const repoDir = path.join(testDir, 'repo')
  const stateDir = path.join(testDir, 'state')
  const store = path.join(stateDir, 'gateway.db')
  const now = new Date('2026-06-16T12:00:00.000Z')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = stateDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = stateDir
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = 'operator-secret-token'
    process.env['TELEGRAM_BOT_TOKEN'] = '123456:telegram-secret-token-value'
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(repoDir, { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
    updateConfig({ channels: { telegram: { botToken: '123456:telegram-secret-token-value' } } } as any)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN']
    delete process.env['TELEGRAM_BOT_TOKEN']
    clearConfigCacheForTest()
  })

  it('exports deterministic redacted bundles without leaking live channel evidence', () => {
    const fixture = seedLiveTelegramFixture()

    const bundle = buildEvidenceBundle({
      target: { taskId: fixture.taskId },
      filePath: store,
      rootDir: repoDir,
      stateDir,
      now,
    })
    const again = buildEvidenceBundle({
      target: { taskId: fixture.taskId },
      filePath: store,
      rootDir: repoDir,
      stateDir,
      now,
    })
    const serialized = JSON.stringify(bundle)
    const markdown = bundle.markdown

    expect(bundle.manifest).toEqual(again.manifest)
    expect(markdown).toEqual(again.markdown)
    expect(serialized).not.toContain('trusted-chat-42')
    expect(serialized).not.toContain('topic-privacy-7')
    expect(serialized).not.toContain('operator-secret-token')
    expect(serialized).not.toContain('telegram-secret-token-value')
    expect(serialized).not.toContain('private channel content')
    expect(serialized).not.toContain('ses_live_private')
    expect(serialized).not.toContain('/Users/joe/private-notes')
    expect(markdown).not.toContain('trusted-chat-42')
    expect(markdown).not.toContain('private channel content')
    expect(markdown).not.toContain('ses_live_private')
    expect(serialized).toContain('<redacted:telegram.chat:')
    expect(serialized).toContain('<redacted:text:')
    expect(bundle.manifest.correlation.channelTargets[0]).toMatchObject({
      provider: 'telegram',
      chatId: expect.stringMatching(/^<redacted:telegram\.chat:/),
      targetHash: expect.stringMatching(/^[a-f0-9]{12}$/),
    })
    expect(bundle.manifest.correlation.traceRootId).toMatch(/^trace_root_[a-f0-9]{16}$/)
    expect(bundle.manifest.correlation.taskTraces).toEqual([
      expect.objectContaining({ taskId: fixture.taskId, traceId: expect.stringMatching(/^trace_task_[a-f0-9]{16}$/) }),
    ])
    expect(bundle.manifest.correlation.runTraces).toEqual([
      expect.objectContaining({ runId: fixture.runId, traceId: expect.stringMatching(/^trace_run_[a-f0-9]{16}$/) }),
    ])
    expect(bundle.manifest.slo.map(row => row.id)).toEqual(expect.arrayContaining(['scheduler_latency', 'run_dispatch', 'channel_delivery']))
    expect(bundle.manifest.evidenceContract).toMatchObject({
      schemaVersion: 1,
      claimState: 'local_beta_evidence_only',
      claim: { state: 'local_beta_evidence_only', effect: 'local_evidence_integrity_only' },
      proof: { state: 'supported_bounded', mode: 'local_state' },
      redaction: { state: 'redacted', safeToShare: true },
      validation: { state: 'pass' },
    })
    expect(bundle.manifest.contractState).toMatchObject({
      claimState: 'local_beta_evidence_only',
      proofState: 'supported_bounded',
      redactionState: 'redacted',
      validationState: 'pass',
      safeToShare: true,
    })
    expect(bundle.manifest.pipeline).toMatchObject({
      mode: 'm41_evidence_pipeline_v2',
      surface: 'evidence_export',
      status: 'pass',
      releaseClaimBoundary: 'local_beta_evidence_pipeline_only_no_release_claim_expansion',
      acceptance: {
        validationGatePass: true,
        redactionGatePass: true,
        decisionGatePass: true,
        noReleaseClaimExpansion: true,
      },
    })
    const availableArtifact = bundle.manifest.artifacts.find(row => row.manifestId && row.status === 'available')
    const omittedArtifact = bundle.manifest.artifacts.find(row => row.manifestId && row.status === 'missing')
    expect(availableArtifact).toMatchObject({
      artifactId: expect.stringMatching(/^artifact_[a-f0-9]{16}$/),
      redactionStatus: 'redacted',
      retentionPolicy: 'external_reference',
      previewSafe: true,
      contentType: 'text/plain; charset=utf-8',
    })
    expect(omittedArtifact).toMatchObject({
      redactionStatus: 'unknown',
      retentionPolicy: 'external_reference',
      previewSafe: false,
      omittedReason: 'file not found',
    })
    expect(bundle.manifest.evidenceContract.evidenceRefs.map(ref => ref.kind)).toEqual(expect.arrayContaining(['trace', 'manifest', 'task', 'run', 'session', 'event']))
    expect(markdown).toContain('Trace root:')
    expect(markdown).toContain('Task traces:')
    expect(markdown).toContain('Evidence contract: pass')
    expect(markdown).toContain('Evidence pipeline: pass')
    expect(markdown).toContain('Proof state: supported_bounded')
  }, 15_000)

  it('requires explicit local admin intent before exporting unredacted evidence', () => {
    const fixture = seedLiveTelegramFixture()

    expect(() => buildEvidenceBundle({
      mode: 'unredacted',
      target: { taskId: fixture.taskId },
      filePath: store,
      rootDir: repoDir,
      stateDir,
      now,
    })).toThrow('explicit local/admin intent')

    const bundle = buildEvidenceBundle({
      mode: 'unredacted',
      allowUnredacted: true,
      target: { taskId: fixture.taskId },
      filePath: store,
      rootDir: repoDir,
      stateDir,
      now,
    })

    expect(JSON.stringify(bundle)).toContain('trusted-chat-42')
    expect(JSON.stringify(bundle)).toContain('private channel content')
    expect(bundle.manifest.evidenceContract).toMatchObject({
      claim: { state: 'local_admin_unredacted_only' },
      proof: { state: 'blocked' },
      redaction: { state: 'unredacted_local_admin_only', safeToShare: false },
      validation: { state: 'fail' },
    })
    expect(bundle.manifest.contractState).toMatchObject({
      claimState: 'local_admin_unredacted_only',
      proofState: 'blocked',
      safeToShare: false,
      validationState: 'fail',
    })
    expect(bundle.manifest.pipeline).toMatchObject({
      mode: 'm41_evidence_pipeline_v2',
      surface: 'evidence_export',
      status: 'fail',
      acceptance: {
        validationGatePass: false,
        redactionGatePass: false,
        noReleaseClaimExpansion: true,
      },
      decision: {
        state: 'decision_blocked',
        claimChange: 'blocked',
      },
    })
    expect(bundle.manifest.evidenceContract.validation.failures.map(failure => failure.code)).toContain('redaction_not_share_safe')
  })

  it('writes redacted markdown and manifest artifacts with private permissions', () => {
    const fixture = seedLiveTelegramFixture()
    const bundle = buildEvidenceBundle({
      target: { taskId: fixture.taskId },
      filePath: store,
      rootDir: repoDir,
      stateDir,
      now,
    })

    const written = writeEvidenceBundle(bundle, path.join(testDir, 'bundle'))

    expect(fs.existsSync(written.manifestPath)).toBe(true)
    expect(fs.existsSync(written.markdownPath)).toBe(true)
    expect(fs.statSync(written.manifestPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(written.markdownPath).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(written.markdownPath, 'utf-8')).not.toContain('trusted-chat-42')
  })

  function seedLiveTelegramFixture(): { roadmapId: string; taskId: string; runId: string } {
    const artifactPath = path.join(repoDir, 'wf3-redacted-note.txt')
    fs.writeFileSync(artifactPath, 'artifact mentions private channel content and trusted-chat-42 with token=operator-secret-token')
    const roadmap = createRoadmap({ title: 'JOE-100 live WF3 receipt drill' }, store)
    const task = createWorkTask({
      title: 'JOE-100 live WF3 receipt drill',
      description: 'Private transcript: private channel content',
      roadmapId: roadmap.id,
      pipeline: ['verify'],
    }, store)
    upsertProjectBinding({
      alias: 'j100wf3',
      roadmapId: roadmap.id,
      sessionId: 'ses_live_private',
      scope: 'telegram',
      provider: 'telegram',
      chatId: 'trusted-chat-42',
      threadId: 'topic-privacy-7',
      title: 'Live WF3',
      allowRebind: true,
    }, store)
    upsertChannelBinding({
      provider: 'telegram',
      chatId: 'trusted-chat-42',
      threadId: 'topic-privacy-7',
      sessionId: 'ses_live_private',
      mode: 'task',
      taskId: task.id,
      title: 'Live WF3',
    }, store)
    const started = startWorkTaskRun(task.id, 'verify', 'ses_live_private', 'verifier', store)!
    completeWorkTaskRun(started.run.id, {
      status: 'pass',
      summary: 'Telegram completed for trusted-chat-42',
      feedback: 'private channel content',
      artifacts: [`file:${artifactPath}`, '/Users/joe/private-notes/wf3.txt'],
      evidence: [{ type: 'note', ref: 'telegram:trusted-chat-42', summary: 'private channel content token=operator-secret-token' }],
      raw: 'raw transcript private channel content trusted-chat-42 topic-privacy-7 123456:telegram-secret-token-value',
    }, 2, store)
    appendWorkEvent('delegation.progress', task.id, {
      notificationTarget: { provider: 'telegram', chatId: 'trusted-chat-42', threadId: 'topic-privacy-7' },
      message: { text: 'private channel content token=operator-secret-token' },
      authorization: 'Bearer operator-secret-token',
      path: '/Users/joe/private-notes/wf3.txt',
    }, store)
    return { roadmapId: roadmap.id, taskId: task.id, runId: started.run.id }
  }
})
