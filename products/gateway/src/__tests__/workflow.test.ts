import { describe, expect, it } from 'vitest'
import { decideNextTaskState, mergeTaskQualitySpecDefaults, normalizeTaskQualitySpec, parseStageResult, profileForStage, type WorkflowTaskLike } from '../workflow.js'

describe('workflow', () => {
  it('parses structured stage results', () => {
    const result = parseStageResult([
      assistant('```json\n{"status":"fail","summary":"bug found","feedback":"fix the edge case","artifacts":["review.md"]}\n```'),
    ], 'review')

    expect(result).toMatchObject({ status: 'fail', summary: 'bug found', feedback: 'fix the edge case', artifacts: ['review.md'], failureClass: 'implementation_failed' })
  })

  it('parses structured evidence, decisions, and failure classes', () => {
    const result = parseStageResult([
      assistant('```json\n{"status":"blocked","summary":"needs token","failureClass":"needs_credentials","artifacts":[{"type":"log","ref":"logs/auth.log"}],"evidence":[{"type":"decision","ref":"ask-user","summary":"credential needed"}],"decisions":["Do not fake credentials"]}\n```'),
    ], 'verify')

    expect(result).toMatchObject({ status: 'blocked', failureClass: 'needs_credentials', evidence: [expect.objectContaining({ type: 'log', ref: 'logs/auth.log' }), expect.objectContaining({ type: 'decision', ref: 'ask-user' })], decisions: ['Do not fake credentials'] })
  })

  it('treats loose implementer text as unknown instead of pass', () => {
    const result = parseStageResult([
      assistant('implemented the change and tests pass'),
    ], 'implement')

    expect(result).toMatchObject({ status: 'unknown', feedback: 'Stage implement did not produce a fenced json pass/fail/blocked result.' })
  })

  it('defers intermediate tool-call continuations without fenced JSON', () => {
    const result = parseStageResult([
      assistant('Let me inspect the repository first.', { finish: 'tool-calls' }),
    ], 'implement')

    expect(result).toBeNull()
  })

  it('uses the latest structured result even when a later assistant fragment has no JSON', () => {
    const result = parseStageResult([
      assistant('```json\n{"status":"pass","summary":"implemented","artifacts":["artifact.json"]}\n```'),
      assistant('## Stage 4: VERIFY'),
    ], 'implement')

    expect(result).toMatchObject({ status: 'pass', summary: 'implemented', artifacts: ['artifact.json'] })
  })

  it('requires review and verify stages before completion', () => {
    const task: WorkflowTaskLike = { id: 'task_1', title: 'Ship', description: 'Ship', pipeline: ['implement', 'review', 'verify'], currentStage: 'implement', attempts: {}, status: 'running' }

    expect(decideNextTaskState(task, 'implement', { status: 'pass', summary: 'implemented', artifacts: [], evidence: [], raw: '' }, 2))
      .toMatchObject({ taskStatus: 'pending', nextStage: 'review' })
    expect(decideNextTaskState(task, 'review', { status: 'pass', summary: 'reviewed', artifacts: [], evidence: [], raw: '' }, 2))
      .toMatchObject({ taskStatus: 'pending', nextStage: 'verify' })
    expect(decideNextTaskState(task, 'verify', { status: 'pass', summary: 'verified', artifacts: [], evidence: [], raw: '' }, 2))
      .toMatchObject({ taskStatus: 'done' })
  })

  it('blocks advancement when required quality evidence is missing', () => {
    const task: WorkflowTaskLike = { id: 'task_1', title: 'Ship', description: 'Ship', pipeline: ['implement', 'verify'], currentStage: 'verify', attempts: { verify: 1 }, status: 'running', qualitySpec: normalizeTaskQualitySpec({ acceptanceCriteria: ['feature works'], definitionOfDone: ['user can save'], verificationCommands: ['npm test'], evidenceRequirements: ['test output'], requiredArtifacts: ['src/app.ts'] }) }

    expect(decideNextTaskState(task, 'verify', { status: 'pass', summary: 'verified', artifacts: [], evidence: [], raw: '' }, 2))
      .toMatchObject({ taskStatus: 'pending', retryStage: 'verify', note: expect.stringContaining('Quality gate missing required evidence') })

    expect(decideNextTaskState(task, 'verify', { status: 'pass', summary: 'verified', artifacts: ['ARTIFACT1 src/app.ts', 'CMD1 npm test'], evidence: [{ type: 'test', ref: 'npm test', summary: 'AC1 feature works; DOD1 user can save; EVIDENCE1 test output passed' }], raw: '' }, 2))
      .toMatchObject({ taskStatus: 'done' })
  })

  it('requires review evidence before advancing to verify', () => {
    const task: WorkflowTaskLike = { id: 'task_1', title: 'Draft deck', description: 'Create slides', pipeline: ['implement', 'review', 'verify'], currentStage: 'review', attempts: { review: 1 }, status: 'running', qualitySpec: normalizeTaskQualitySpec({ acceptanceCriteria: ['deck covers budget risk'], definitionOfDone: ['slides ready for board review'], requiredArtifacts: ['board-deck.pdf'] }) }

    expect(decideNextTaskState(task, 'review', { status: 'pass', summary: 'looks good', artifacts: [], evidence: [], raw: '' }, 2))
      .toMatchObject({ taskStatus: 'pending', retryStage: 'implement', note: expect.stringContaining('at least one artifact or evidence entry') })

    expect(decideNextTaskState(task, 'review', { status: 'pass', summary: 'reviewed deck', artifacts: ['board-deck.pdf'], evidence: [{ type: 'file', ref: 'board-deck.pdf', summary: 'review found no defects' }], raw: '' }, 2))
      .toMatchObject({ taskStatus: 'pending', nextStage: 'verify' })
  })

  it('requires explicit quality item IDs for final quality checks', () => {
    const task: WorkflowTaskLike = { id: 'task_1', title: 'Metadata audit', description: 'Fix changed mode', pipeline: ['implement', 'review', 'verify'], currentStage: 'verify', attempts: { verify: 1 }, status: 'running', qualitySpec: normalizeTaskQualitySpec({ acceptanceCriteria: ['Changed YAML patch files select corresponding model entities through patch_path.'], definitionOfDone: ['No commit, push, PR, or Linear mutation occurs.'], verificationCommands: ['cargo test --locked audit_cmd'], evidenceRequirements: ['Git status and changed file list.'] }) }

    expect(decideNextTaskState(task, 'verify', {
      status: 'pass',
      summary: 'Verified changed-file entity matching and no external mutation.',
      artifacts: ['cargo test --locked audit_cmd', 'git status --short'],
      evidence: [
        { type: 'diff', ref: 'src/cli/audit_cmd.rs', summary: 'Changed-file entity matching checks original_file_path and patch_path, covering YAML patch/schema files for model entities.' },
        { type: 'command', ref: 'git status --short', summary: 'Changed file list captured; no commits, pushes, PRs, or Linear mutations occurred.' },
      ],
      raw: '',
    }, 2)).toMatchObject({ taskStatus: 'pending', retryStage: 'verify', note: expect.stringContaining('acceptance criterion') })

    expect(decideNextTaskState(task, 'verify', {
      status: 'pass',
      summary: 'Verified changed-file entity matching and no external mutation.',
      artifacts: ['CMD1 cargo test --locked audit_cmd', 'EVIDENCE1 git status --short'],
      evidence: [
        { type: 'diff', ref: 'src/cli/audit_cmd.rs', summary: 'AC1 changed-file entity matching checks original_file_path and patch_path, covering YAML patch/schema files for model entities.' },
        { type: 'command', ref: 'git status --short', summary: 'DOD1 changed file list captured; no commits, pushes, PRs, or Linear mutations occurred.' },
      ],
      raw: '',
    }, 2)).toMatchObject({ taskStatus: 'done' })
  })

  it('retries review failures at implement and other stage failures at the failed stage', () => {
    const task: WorkflowTaskLike = { id: 'task_1', title: 'Ship', description: 'Ship', pipeline: ['implement', 'review', 'verify'], currentStage: 'review', attempts: { review: 1, verify: 1 }, status: 'running' }

    expect(decideNextTaskState(task, 'review', { status: 'fail', summary: 'bug found', feedback: 'fix it', artifacts: [], evidence: [], raw: '' }, 2))
      .toMatchObject({ taskStatus: 'pending', retryStage: 'implement', note: 'fix it' })
    expect(decideNextTaskState(task, 'verify', { status: 'unknown', summary: 'no evidence', artifacts: [], evidence: [], raw: '' }, 2))
      .toMatchObject({ taskStatus: 'pending', retryStage: 'verify', note: 'no evidence' })
  })

  it('routes verifier-discovered implementation failures back to implement', () => {
    const task: WorkflowTaskLike = { id: 'task_1', title: 'Ship', description: 'Ship', pipeline: ['implement', 'review', 'verify'], currentStage: 'verify', attempts: { verify: 1 }, status: 'running' }

    expect(decideNextTaskState(task, 'verify', { status: 'fail', summary: 'done criteria not met', feedback: 'update the artifact', failureClass: 'implementation_failed', artifacts: [], evidence: [], raw: '' }, 2))
      .toMatchObject({ taskStatus: 'pending', retryStage: 'implement', note: 'update the artifact' })
  })

  it('blocks stages that are not part of the task pipeline', () => {
    const task: WorkflowTaskLike = { id: 'task_1', title: 'Ship', description: 'Ship', pipeline: ['implement', 'review', 'verify'], currentStage: 'audit', attempts: {}, status: 'running' }

    expect(decideNextTaskState(task, 'audit', { status: 'pass', summary: 'audited', artifacts: [], evidence: [], raw: '' }, 2))
      .toMatchObject({ taskStatus: 'blocked', blockedReason: 'Stage is not in task pipeline: audit' })
  })

  it('routes stage names to configured profile names', () => {
    expect(profileForStage('review', { retryLimit: 2, stageProfiles: { default: 'implementer', review: 'reviewer' } })).toBe('reviewer')
    expect(profileForStage('unknown', { retryLimit: 2, stageProfiles: { default: 'implementer' } })).toBe('implementer')
  })

  it('merges agent team quality defaults without dropping task-specific evidence', () => {
    const merged = mergeTaskQualitySpecDefaults(
      normalizeTaskQualitySpec({ acceptanceCriteria: ['task-specific'], requiredTools: ['node'], verificationCommands: ['npm test'] }),
      { acceptanceCriteria: ['team-default'], requiredTools: ['uv'], verificationCommands: ['dbt test'], evidenceRequirements: ['warehouse proof'] },
    )

    expect(merged).toMatchObject({
      acceptanceCriteria: ['team-default', 'task-specific'],
      requiredTools: ['uv', 'node'],
      verificationCommands: ['dbt test', 'npm test'],
      evidenceRequirements: ['warehouse proof'],
    })
  })

  it('normalizes required preflight tools in quality specs', () => {
    expect(normalizeTaskQualitySpec({ requiredTools: [' actionlint ', 'uv', 'uv'] })).toMatchObject({ requiredTools: ['actionlint', 'uv'] })
  })
})

function assistant(text: string, info: Record<string, unknown> = {}) {
  return {
    info: { role: 'assistant', time: { created: 1, completed: 2 }, ...info },
    parts: [{ type: 'text', text }, { type: 'step-finish', reason: info['finish'] }],
  }
}
