import type { AgentProfile } from './config.js'

export type WorkStatus = 'pending' | 'running' | 'done' | 'blocked' | 'paused' | 'cancelled' | 'archived'
export type RunStatus = 'running' | 'passed' | 'failed' | 'blocked' | 'errored'
export type StageResultStatus = 'pass' | 'fail' | 'blocked' | 'unknown'
export type FailureClass = 'blocked' | 'needs_user_input' | 'needs_credentials' | 'flaky_test' | 'unsafe' | 'exceeded_budget' | 'unclear_spec' | 'implementation_failed' | 'verification_failed'

export type EvidenceType = 'diff' | 'test' | 'command' | 'link' | 'screenshot' | 'log' | 'decision' | 'file' | 'note' | 'other'

export interface StageEvidence {
  type: EvidenceType
  ref: string
  summary?: string
}

export interface TaskQualitySpec {
  objective?: string
  constraints: string[]
  acceptanceCriteria: string[]
  definitionOfDone: string[]
  filesTouched: string[]
  systemsTouched: string[]
  requiredTools: string[]
  verificationCommands: string[]
  rollbackPlan?: string
  evidenceRequirements: string[]
  requiredArtifacts: string[]
}

export interface StageResult {
  status: StageResultStatus
  summary: string
  feedback?: string
  artifacts: string[]
  evidence?: StageEvidence[]
  decisions?: string[]
  failureClass?: FailureClass
  raw: string
}

export interface WorkflowTaskLike {
  id: string
  title: string
  description: string
  pipeline: string[]
  currentStage?: string
  attempts: Record<string, number>
  status: WorkStatus
  note?: string
  qualitySpec?: TaskQualitySpec
  roadmapMemory?: string
}

export interface WorkflowDecision {
  taskStatus: WorkStatus
  nextStage?: string
  retryStage?: string
  blockedReason?: string
  note?: string
}

export interface SchedulerConfigLike {
  retryLimit: number
  stageProfiles: Record<string, string>
}

export function defaultPipeline(): string[] {
  return ['implement', 'review', 'verify']
}

export function profileForStage(stage: string, scheduler: SchedulerConfigLike): string {
  return scheduler.stageProfiles[stage] || scheduler.stageProfiles['default'] || 'implementer'
}

export function buildStagePrompt(task: WorkflowTaskLike, stage: string, profile: AgentProfile, feedback?: string): string {
  const acceptance = task.note ? `\n\nAcceptance/context:\n${task.note}` : ''
  const quality = formatQualitySpec(task.qualitySpec)
  const memory = task.roadmapMemory ? `\n\nRoadmap memory:\n${task.roadmapMemory}` : ''
  const prior = feedback ? `\n\nPrior feedback to address:\n${feedback}` : ''
  return [
    `Issue: ${task.title}`,
    '',
    task.description,
    acceptance,
    quality,
    memory,
    prior,
    '',
    `Stage: ${stage}`,
    `OpenCode agent: ${profile.agent}`,
    `Expected skills: ${profile.skills.join(', ') || 'none declared'}`,
    '',
    stageInstructions(stage),
    '',
    'Finish with a JSON object in a fenced json block using this schema:',
    '```json',
    '{"status":"pass|fail|blocked","summary":"short result","feedback":"specific feedback for the next attempt if any","failureClass":"blocked|needs_user_input|needs_credentials|flaky_test|unsafe|exceeded_budget|unclear_spec|implementation_failed|verification_failed","artifacts":["short artifact refs"],"evidence":[{"type":"diff|test|command|link|screenshot|log|decision|file|note|other","ref":"file, command, URL, log path, or decision id","summary":"why it proves the implementation spec or definition of done"}],"decisions":["durable decisions made"]}',
    '```',
  ].filter(Boolean).join('\n')
}

export function parseStageResult(messages: any[], stage: string): StageResult | null {
  let lastText = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isAssistantComplete(messages[i])) continue
    const text = extractText(messages[i])
    if (!text) continue
    const structured = parseStructuredResult(text)
    if (structured) return { ...structured, raw: text.substring(0, 2000) }
    if (isToolCallContinuation(messages[i])) continue
    if (!lastText) lastText = text
  }

  if (!lastText) return null
  return { status: 'unknown', summary: lastText.substring(0, 500), feedback: `Stage ${stage} did not produce a fenced json pass/fail/blocked result.`, artifacts: [], evidence: [], failureClass: inferFailureClass(stage, lastText), raw: lastText.substring(0, 2000) }
}

export function decideNextTaskState(task: WorkflowTaskLike, stage: string, result: StageResult, retryLimit: number): WorkflowDecision {
  if (!task.pipeline.includes(stage)) {
    return { taskStatus: 'blocked', blockedReason: `Stage is not in task pipeline: ${stage}`, note: `Blocked invalid stage: ${stage}` }
  }

  if (result.status === 'blocked') {
    return { taskStatus: 'blocked', blockedReason: result.feedback || result.summary, note: result.summary }
  }

  if (result.status === 'fail' || result.status === 'unknown') {
    const attempts = task.attempts[stage] || 0
    if (attempts >= retryLimit) {
      return { taskStatus: 'blocked', blockedReason: result.feedback || result.summary, note: `Blocked after ${attempts} ${stage} attempt(s): ${result.summary}` }
    }
    return { taskStatus: 'pending', retryStage: retryStageFor(stage, result), note: result.feedback || result.summary }
  }

  const quality = validateStageResultQuality(task, stage, result)
  if (!quality.ok) {
    const attempts = task.attempts[stage] || 0
    if (attempts >= retryLimit) {
      return { taskStatus: 'blocked', blockedReason: quality.feedback, note: `Blocked by quality gate after ${attempts} ${stage} attempt(s): ${quality.feedback}` }
    }
    return { taskStatus: 'pending', retryStage: retryStageFor(stage, result), note: quality.feedback }
  }

  const idx = task.pipeline.indexOf(stage)
  const nextStage = idx >= 0 ? task.pipeline[idx + 1] : undefined
  if (!nextStage) return { taskStatus: 'done', note: result.summary }
  return { taskStatus: 'pending', nextStage, note: result.summary }
}

export function isAssistantComplete(message: any): boolean {
  if (message?.info?.role !== 'assistant') return false
  if (typeof message?.info?.time?.completed === 'number') return true
  return (Array.isArray(message?.parts) ? message.parts : []).some((part: any) => part?.type === 'step-finish')
}

function isToolCallContinuation(message: any): boolean {
  if (message?.info?.finish === 'tool-calls') return true
  return (Array.isArray(message?.parts) ? message.parts : []).some((part: any) => part?.type === 'step-finish' && part.reason === 'tool-calls')
}

function extractText(message: any): string {
  return (Array.isArray(message?.parts) ? message.parts : [])
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('\n')
    .trim()
}

function parseStructuredResult(text: string): Omit<StageResult, 'raw'> | null {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate)
      const status = normalizeStatus(parsed?.status)
      if (!status) continue
      return {
        status,
        summary: typeof parsed.summary === 'string' ? parsed.summary.substring(0, 1000) : '',
        feedback: typeof parsed.feedback === 'string' ? parsed.feedback.substring(0, 2000) : undefined,
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.filter((v: any) => typeof v === 'string').slice(0, 20) : [],
        evidence: normalizeEvidence(parsed.evidence, parsed.artifacts),
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions.filter((v: any) => typeof v === 'string').slice(0, 20) : undefined,
        failureClass: normalizeFailureClass(parsed.failureClass || parsed.failure || parsed.classification) || (status === 'pass' ? undefined : inferFailureClass('', `${parsed.summary || ''} ${parsed.feedback || ''}`)),
      }
    } catch {}
  }
  return null
}

export function normalizeTaskQualitySpec(value: unknown): TaskQualitySpec | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return undefined
    return { objective: text.substring(0, 1000), constraints: [], acceptanceCriteria: [], definitionOfDone: [], filesTouched: [], systemsTouched: [], requiredTools: [], verificationCommands: [], evidenceRequirements: [], requiredArtifacts: [] }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('qualitySpec must be an object')
  const input = value as any
  return {
    objective: optionalText(input.objective, 1000),
    constraints: stringList(input.constraints, 'qualitySpec.constraints'),
    acceptanceCriteria: stringList(input.acceptanceCriteria, 'qualitySpec.acceptanceCriteria'),
    definitionOfDone: stringList(input.definitionOfDone || input.definitionOfDoneCriteria || input.doneCriteria, 'qualitySpec.definitionOfDone'),
    filesTouched: stringList(input.filesTouched, 'qualitySpec.filesTouched'),
    systemsTouched: stringList(input.systemsTouched, 'qualitySpec.systemsTouched'),
    requiredTools: stringList(input.requiredTools, 'qualitySpec.requiredTools'),
    verificationCommands: stringList(input.verificationCommands, 'qualitySpec.verificationCommands'),
    rollbackPlan: optionalText(input.rollbackPlan, 2000),
    evidenceRequirements: stringList(input.evidenceRequirements, 'qualitySpec.evidenceRequirements'),
    requiredArtifacts: stringList(input.requiredArtifacts, 'qualitySpec.requiredArtifacts'),
  }
}

export function mergeTaskQualitySpecDefaults(taskSpec: TaskQualitySpec | undefined, defaults: unknown): TaskQualitySpec | undefined {
  const normalizedDefaults = normalizeTaskQualitySpec(defaults)
  if (!normalizedDefaults) return taskSpec
  if (!taskSpec) return normalizedDefaults
  return {
    objective: taskSpec.objective || normalizedDefaults.objective,
    constraints: mergeStringLists(normalizedDefaults.constraints, taskSpec.constraints),
    acceptanceCriteria: mergeStringLists(normalizedDefaults.acceptanceCriteria, taskSpec.acceptanceCriteria),
    definitionOfDone: mergeStringLists(normalizedDefaults.definitionOfDone, taskSpec.definitionOfDone),
    filesTouched: mergeStringLists(normalizedDefaults.filesTouched, taskSpec.filesTouched),
    systemsTouched: mergeStringLists(normalizedDefaults.systemsTouched, taskSpec.systemsTouched),
    requiredTools: mergeStringLists(normalizedDefaults.requiredTools, taskSpec.requiredTools),
    verificationCommands: mergeStringLists(normalizedDefaults.verificationCommands, taskSpec.verificationCommands),
    rollbackPlan: taskSpec.rollbackPlan || normalizedDefaults.rollbackPlan,
    evidenceRequirements: mergeStringLists(normalizedDefaults.evidenceRequirements, taskSpec.evidenceRequirements),
    requiredArtifacts: mergeStringLists(normalizedDefaults.requiredArtifacts, taskSpec.requiredArtifacts),
  }
}

export function validateStageResultQuality(task: WorkflowTaskLike, stage: string, result: StageResult): { ok: boolean; feedback?: string } {
  if (result.status !== 'pass') return { ok: true }
  const spec = task.qualitySpec
  if (!spec) return { ok: true }
  const isFinalStage = task.pipeline.indexOf(stage) === task.pipeline.length - 1
  const shouldValidate = isFinalStage || stage === 'review' || stage === 'verify' || stage === 'audit'
  if (!shouldValidate) return { ok: true }
  const evidenceText = [result.summary, result.feedback || '', ...result.artifacts, ...(result.evidence || []).flatMap(item => [item.type, item.ref, item.summary || '']), ...(result.decisions || [])].join('\n')
  const requiresEvidence = !!(spec.acceptanceCriteria.length || spec.definitionOfDone.length || spec.constraints.length || spec.verificationCommands.length || spec.evidenceRequirements.length || spec.requiredArtifacts.length)
  const missing: string[] = []
  if (stage === 'review') {
    if (requiresEvidence && !result.artifacts.length && !(result.evidence || []).length) missing.push('at least one artifact or evidence entry')
    if (missing.length) return { ok: false, feedback: `Quality gate missing required evidence for ${stage}: ${missing.join('; ')}` }
    return { ok: true }
  }
  for (const [index, criterion] of spec.acceptanceCriteria.entries()) {
    const id = qualitySpecItemId('AC', index)
    if (!evidenceCitesQualityId(evidenceText, id)) missing.push(`acceptance criterion ${id}: ${criterion}`)
  }
  for (const [index, done] of spec.definitionOfDone.entries()) {
    const id = qualitySpecItemId('DOD', index)
    if (!evidenceCitesQualityId(evidenceText, id)) missing.push(`definition of done ${id}: ${done}`)
  }
  for (const [index, constraint] of spec.constraints.entries()) {
    const id = qualitySpecItemId('CONSTRAINT', index)
    if (!evidenceCitesQualityId(evidenceText, id)) missing.push(`constraint ${id}: ${constraint}`)
  }
  for (const [index, command] of spec.verificationCommands.entries()) {
    const id = qualitySpecItemId('CMD', index)
    if (!evidenceCitesQualityId(evidenceText, id)) missing.push(`verification command ${id}: ${command}`)
  }
  for (const [index, requirement] of spec.evidenceRequirements.entries()) {
    const id = qualitySpecItemId('EVIDENCE', index)
    if (!evidenceCitesQualityId(evidenceText, id)) missing.push(`evidence ${id}: ${requirement}`)
  }
  for (const [index, artifact] of spec.requiredArtifacts.entries()) {
    const id = qualitySpecItemId('ARTIFACT', index)
    if (!evidenceCitesQualityId(evidenceText, id)) missing.push(`artifact ${id}: ${artifact}`)
  }
  if (requiresEvidence && !result.artifacts.length && !(result.evidence || []).length) {
    missing.push('at least one artifact or evidence entry')
  }
  if (missing.length) return { ok: false, feedback: `Quality gate missing required evidence for ${stage}: ${missing.join('; ')}` }
  return { ok: true }
}

function evidenceCitesQualityId(evidenceText: string, id: string): boolean {
  return evidenceText.toUpperCase().split(/[^A-Z0-9]+/).includes(id.toUpperCase())
}

function qualitySpecItemId(prefix: string, index: number): string {
  return `${prefix}${index + 1}`
}

function formatQualitySpec(spec?: TaskQualitySpec): string {
  if (!spec) return ''
  const lines = ['\n\nTask quality spec:']
  if (spec.objective) lines.push(`Objective: ${spec.objective}`)
  appendIndexedList(lines, 'Acceptance criteria', 'AC', spec.acceptanceCriteria)
  appendIndexedList(lines, 'Definition of done', 'DOD', spec.definitionOfDone)
  appendIndexedList(lines, 'Constraints', 'CONSTRAINT', spec.constraints)
  appendList(lines, 'Files/systems touched', [...spec.filesTouched, ...spec.systemsTouched])
  appendList(lines, 'Required local tools for Gateway preflight', spec.requiredTools)
  appendIndexedList(lines, 'Required verification commands', 'CMD', spec.verificationCommands)
  appendIndexedList(lines, 'Required evidence', 'EVIDENCE', spec.evidenceRequirements)
  appendIndexedList(lines, 'Required artifacts', 'ARTIFACT', spec.requiredArtifacts)
  if (spec.rollbackPlan) lines.push(`Rollback plan: ${spec.rollbackPlan}`)
  lines.push('A passing review stage must cite concrete artifacts/evidence. A passing verify/final/audit stage must cite every applicable quality item ID (for example AC1, DOD1, CONSTRAINT1, CMD1, EVIDENCE1, ARTIFACT1) in artifacts/evidence.')
  return lines.join('\n')
}

function mergeStringLists(defaults: string[], overrides: string[]): string[] {
  return [...new Set([...defaults, ...overrides])]
}

function appendList(lines: string[], title: string, values: string[]): void {
  if (values.length) lines.push(`${title}: ${values.join('; ')}`)
}

function appendIndexedList(lines: string[], title: string, prefix: string, values: string[]): void {
  if (values.length) lines.push(`${title}: ${values.map((value, index) => `${qualitySpecItemId(prefix, index)} ${value}`).join('; ')}`)
}

function normalizeEvidence(evidence: unknown, artifacts: unknown): StageEvidence[] {
  const rows: StageEvidence[] = []
  if (Array.isArray(artifacts)) {
    for (const item of artifacts) {
      if (item && typeof item === 'object' && !Array.isArray(item)) rows.push(normalizeEvidenceObject(item))
    }
  }
  if (Array.isArray(evidence)) {
    for (const item of evidence) rows.push(normalizeEvidenceObject(item))
  }
  return rows.filter(row => row.ref).slice(0, 50)
}

function normalizeEvidenceObject(item: any): StageEvidence {
  if (typeof item === 'string') return { type: 'other', ref: item.substring(0, 500) }
  const type = normalizeEvidenceType(item?.type)
  return {
    type,
    ref: String(item?.ref || item?.command || item?.path || item?.url || item?.summary || '').substring(0, 500),
    summary: typeof item?.summary === 'string' ? item.summary.substring(0, 1000) : undefined,
  }
}

function normalizeEvidenceType(value: unknown): EvidenceType {
  const type = String(value || 'other')
  return ['diff', 'test', 'command', 'link', 'screenshot', 'log', 'decision', 'file', 'note', 'other'].includes(type) ? type as EvidenceType : 'other'
}

function normalizeFailureClass(value: unknown): FailureClass | undefined {
  const klass = String(value || '').toLowerCase()
  return ['blocked', 'needs_user_input', 'needs_credentials', 'flaky_test', 'unsafe', 'exceeded_budget', 'unclear_spec', 'implementation_failed', 'verification_failed'].includes(klass) ? klass as FailureClass : undefined
}

function inferFailureClass(stage: string, text: string): FailureClass {
  const value = text.toLowerCase()
  if (value.includes('credential') || value.includes('secret') || value.includes('token')) return 'needs_credentials'
  if (value.includes('user input') || value.includes('clarify') || value.includes('question')) return 'needs_user_input'
  if (value.includes('flaky')) return 'flaky_test'
  if (value.includes('unsafe') || value.includes('security')) return 'unsafe'
  if (value.includes('budget') || value.includes('quota')) return 'exceeded_budget'
  if (value.includes('unclear') || value.includes('ambiguous')) return 'unclear_spec'
  return stage === 'verify' || stage === 'review' || stage === 'audit' ? 'verification_failed' : 'implementation_failed'
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null || value === '') return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return [...new Set(value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${label}[${index}] must be a string`)
    return item.trim().substring(0, 500)
  }).filter(Boolean))].slice(0, 50)
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('qualitySpec text fields must be strings')
  const text = value.trim()
  return text ? text.substring(0, maxLength) : undefined
}

function jsonCandidates(text: string): string[] {
  return [...text.matchAll(/```json\s*([\s\S]*?)```/gi)].map(match => match[1]!.trim())
}

function normalizeStatus(value: any): StageResultStatus | null {
  const status = String(value || '').toLowerCase()
  if (['pass', 'passed', 'ok', 'done', 'success'].includes(status)) return 'pass'
  if (['fail', 'failed', 'failure', 'retry'].includes(status)) return 'fail'
  if (['blocked', 'blocker'].includes(status)) return 'blocked'
  return null
}

function retryStageFor(stage: string, result?: StageResult): string {
  if (stage === 'review') return 'implement'
  if (stage === 'verify' && result?.failureClass === 'implementation_failed') return 'implement'
  return stage
}

function stageInstructions(stage: string): string {
  if (stage === 'implement') return 'Implement the requested work, which may be code, docs, slides, research, operations, or another artifact. Leave work uncommitted and unpushed unless the task explicitly requires commits or pushes. Do not mark the task complete; produce artifacts and evidence for review against the implementation spec and definition of done. For Git worktree changes, write a unified diff patch file such as `.gateway/patches/<task>.patch`, include it in artifacts as `patch:<path>`, and cite changed files with diff evidence so Gateway can hydrate dependent tasks. Use OpenCode-native questions or permission requests when needed.'
  if (stage === 'review') return 'Review the implementation against the task description, quality spec, acceptance criteria, constraints, and definition of done. This is not code-only: review docs, slides, research, operations, and external artifacts by their stated spec. For code changes, also check bugs, regressions, missing tests, security issues, and maintainability. Return fail with actionable feedback if anything material is wrong.'
  if (stage === 'verify') return 'Validate completion against the implementation spec and definition of done using the smallest sufficient proof: commands, artifact inspection, screenshots, links, logs, or decisions as appropriate. Return pass only when evidence is sufficient. Every required quality item has a deterministic ID in the task quality spec; include each applicable ID (AC1, DOD1, CONSTRAINT1, CMD1, EVIDENCE1, ARTIFACT1, etc.) in your final JSON artifacts/evidence. If verification shows the implementation itself is wrong, fail with failureClass implementation_failed so Gateway routes back to implement.'
  if (stage === 'audit') return 'Audit the completed work for broader risks and production readiness. Every required quality item has a deterministic ID in the task quality spec; include each applicable ID (AC1, DOD1, CONSTRAINT1, CMD1, EVIDENCE1, ARTIFACT1, etc.) in your final JSON artifacts/evidence. Return fail or blocked for unresolved risks.'
  if (stage === 'plan') return 'Clarify the plan, break down the work, and identify dependencies before implementation.'
  return 'Complete this workflow stage and provide a structured result.'
}
