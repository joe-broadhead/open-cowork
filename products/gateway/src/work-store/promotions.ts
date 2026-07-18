/**
 * Promotion scorecard & decision domain for the work store.
 *
 * Self-contained promotion lifecycle: evidence scorecards, regression
 * guardrails, promote/deprecate/rollback decisions gated by human gates, and
 * rollback-eligibility assessment. Split verbatim out of `work-store.ts` (#199
 * analytics-queries pattern) with no behavior change — exported names and
 * signatures are identical to their previous `work-store.ts` definitions, and
 * external importers reach them here directly. The shared connection/transaction
 * primitives (`openWorkDb`, `withWorkDb`, the `appendWorkEventRow` event-append
 * path, and the `insertHumanGateRow`/`rowToHumanGate` human-gate row helpers)
 * remain single-sourced in `work-store.ts` and are imported from there, so the
 * promotion writers stay byte-identical to the original in-transaction behavior.
 */
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { stableStringify } from '../stable-stringify.js'
import { getConfig, updateConfig, validateAgentTeamConfig, validateProfileConfig, type AgentPromotionState, type AgentProfile, type AgentTeamConfig } from '../config.js'
import { openWorkDb, parseJSON, queryRows, withWorkDb, workStatePath } from './db.js'
import { rowToHumanGate } from './row-mappers.js'
import { appendWorkEventRow, insertHumanGateRow, type HumanGateInput } from '../work-store.js'
import { normalizeOptionalString, normalizeRequiredString, normalizeStringList } from './validators.js'

export type PromotionSubjectKind = 'profile' | 'team'
export type PromotionEvidenceSourceKind = 'arena' | 'eval' | 'manual'
export type PromotionRecommendation = 'promote' | 'hold' | 'block' | 'deprecate'
export type PromotionAction = 'promote' | 'deprecate' | 'rollback' | 'block'
export type PromotionDecisionStatus = 'pending' | 'approved' | 'rejected' | 'applied'

const PROMOTION_REGRESSION_WARN_DELTA = 0.05
const PROMOTION_REGRESSION_BLOCK_DELTA = 0.15
const UNSAFE_PROMOTION_ALLOW_KEYS = new Set(['', '*'])

export interface PromotionMetricScore {
  id: string
  score: number
  maxScore: number
  passed: boolean
  diagnostic?: string
}

export interface PromotionThreshold {
  id: string
  metric: string
  minScore?: number
  minPercentage?: number
  actualScore: number
  actualPercentage: number
  passed: boolean
}

export type PromotionRegressionStatus = 'not_applicable' | 'pass' | 'warning' | 'blocked'

export interface PromotionRegressionGuardrail {
  status: PromotionRegressionStatus
  baselineScorecardId?: string
  baselineDecisionId?: string
  baselineRevision?: string
  metric?: string
  baselinePercentage?: number
  currentPercentage?: number
  delta?: number
  warnThreshold: number
  blockThreshold: number
  message: string
}

export interface PromotionScorecardRecord {
  id: string
  subjectKind: PromotionSubjectKind
  subjectName: string
  subjectRevision: string
  sourceKind: PromotionEvidenceSourceKind
  sourceId: string
  sourceVersion?: string
  metrics: PromotionMetricScore[]
  thresholds: PromotionThreshold[]
  evidence: string[]
  conclusion: string
  recommendation: PromotionRecommendation
  status: AgentPromotionState
  regression?: PromotionRegressionGuardrail
  gateId?: string
  createdAt: string
  updatedAt: string
}

export interface PromotionScorecardInput {
  id?: string
  subjectKind: PromotionSubjectKind
  subjectName: string
  subjectRevision?: string
  sourceKind?: PromotionEvidenceSourceKind
  sourceId: string
  sourceVersion?: string
  metrics?: PromotionMetricScore[]
  thresholds?: Partial<PromotionThreshold>[]
  evidence?: string[]
  conclusion?: string
  recommendation?: PromotionRecommendation
  status?: AgentPromotionState
  regression?: PromotionRegressionGuardrail
  gateId?: string
  projectPromotionState?: boolean
}

export interface PromotionDecisionRecord {
  id: string
  subjectKind: PromotionSubjectKind
  subjectName: string
  subjectRevision: string
  action: PromotionAction
  fromStatus: AgentPromotionState
  toStatus: AgentPromotionState
  scorecardId?: string
  gateId?: string
  status: PromotionDecisionStatus
  actor?: string
  source?: string
  note?: string
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface PromotionRollbackEligibility {
  eligible: boolean
  status: 'eligible' | 'not_needed' | 'missing_subject' | 'no_baseline' | 'invalid_baseline' | 'revision_mismatch' | 'unsafe_subject'
  targetStatus?: AgentPromotionState
  baselineDecisionId?: string
  baselineScorecardId?: string
  baselineRevision?: string
  reason: string
}

export function createPromotionScorecard(input: PromotionScorecardInput, filePath = workStatePath()): PromotionScorecardRecord {
  const db = openWorkDb(filePath)
  let projection: PromotionScorecardRecord | undefined
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const now = new Date().toISOString()
      const scorecard = applyRegressionGuardrails(db, normalizePromotionScorecardInput(input, now))
      db.prepare(`INSERT INTO promotion_scorecards (
        id, subject_kind, subject_name, subject_revision, source_kind, source_id, source_version,
        metrics_json, thresholds_json, evidence_json, conclusion, recommendation, status, regression_json, gate_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        subject_kind = excluded.subject_kind,
        subject_name = excluded.subject_name,
        subject_revision = excluded.subject_revision,
        source_kind = excluded.source_kind,
        source_id = excluded.source_id,
        source_version = excluded.source_version,
        metrics_json = excluded.metrics_json,
        thresholds_json = excluded.thresholds_json,
        evidence_json = excluded.evidence_json,
        conclusion = excluded.conclusion,
        recommendation = excluded.recommendation,
        status = excluded.status,
        regression_json = excluded.regression_json,
        gate_id = excluded.gate_id,
        updated_at = excluded.updated_at`).run(
        scorecard.id,
        scorecard.subjectKind,
        scorecard.subjectName,
        scorecard.subjectRevision,
        scorecard.sourceKind,
        scorecard.sourceId,
        scorecard.sourceVersion || null,
        JSON.stringify(scorecard.metrics),
        JSON.stringify(scorecard.thresholds),
        JSON.stringify(scorecard.evidence),
        scorecard.conclusion,
        scorecard.recommendation,
        scorecard.status,
        JSON.stringify(scorecard.regression || null),
        scorecard.gateId || null,
        scorecard.createdAt,
        scorecard.updatedAt,
      )
      if (input.projectPromotionState !== false) projection = scorecard
      appendWorkEventRow(db, 'promotion.scorecard.upserted', promotionSubjectKey(scorecard.subjectKind, scorecard.subjectName), { scorecardId: scorecard.id, recommendation: scorecard.recommendation, status: scorecard.status, source: `${scorecard.sourceKind}:${scorecard.sourceId}`, regression: scorecard.regression }, now)
      db.exec('COMMIT')
      if (projection) applyEvaluatedPromotionProjection(projection)
      return rowToPromotionScorecard(db.prepare('SELECT * FROM promotion_scorecards WHERE id = ?').get(scorecard.id))!
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function listPromotionScorecards(filter: { subjectKind?: PromotionSubjectKind; subjectName?: string; status?: AgentPromotionState } = {}, filePath = workStatePath()): PromotionScorecardRecord[] {
  return withWorkDb(filePath, db => {
    let rows = queryRows(db, 'SELECT * FROM promotion_scorecards ORDER BY created_at DESC').map(rowToPromotionScorecard).filter(Boolean) as PromotionScorecardRecord[]
    if (filter.subjectKind) rows = rows.filter(row => row.subjectKind === filter.subjectKind)
    if (filter.subjectName) rows = rows.filter(row => row.subjectName === filter.subjectName)
    if (filter.status) rows = rows.filter(row => row.status === filter.status)
    return rows
  })
}

export function getPromotionScorecard(id: string, filePath = workStatePath()): PromotionScorecardRecord | undefined {
  return withWorkDb(filePath, db => rowToPromotionScorecard(db.prepare('SELECT * FROM promotion_scorecards WHERE id = ?').get(id)) || undefined)
}

export function getPromotionState(subjectKind: PromotionSubjectKind, subjectName: string, filePath = workStatePath()): { state: AgentPromotionState; scorecard?: PromotionScorecardRecord; decision?: PromotionDecisionRecord; rollback: PromotionRollbackEligibility } {
  return withWorkDb(filePath, db => {
    const scorecard = rowToPromotionScorecard(db.prepare('SELECT * FROM promotion_scorecards WHERE subject_kind = ? AND subject_name = ? ORDER BY updated_at DESC LIMIT 1').get(subjectKind, subjectName)) || undefined
    const decision = rowToPromotionDecision(db.prepare("SELECT * FROM promotion_decisions WHERE subject_kind = ? AND subject_name = ? AND status = 'applied' ORDER BY updated_at DESC LIMIT 1").get(subjectKind, subjectName)) || undefined
    const configState = configPromotionState(subjectKind, subjectName)
    const state = decision?.toStatus || scorecard?.status || configState || 'draft'
    return { state, scorecard, decision, rollback: promotionRollbackEligibilityFromDb(db, subjectKind, subjectName, state) }
  })
}


export function applyPromotionDecision(input: { decisionId?: string; subjectKind?: PromotionSubjectKind; subjectName?: string; action?: PromotionAction; scorecardId?: string; gateId?: string; actor?: string; source?: string; note?: string }, filePath = workStatePath()): PromotionDecisionRecord | undefined {
  const db = openWorkDb(filePath)
  let projection: { subjectKind: PromotionSubjectKind; subjectName: string; state: AgentPromotionState } | undefined
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const now = new Date().toISOString()
      const decision = input.decisionId
        ? rowToPromotionDecision(db.prepare('SELECT * FROM promotion_decisions WHERE id = ?').get(input.decisionId))
        : buildPromotionDecisionRecord(db, { subjectKind: input.subjectKind!, subjectName: input.subjectName!, action: input.action!, scorecardId: input.scorecardId, gateId: input.gateId, actor: input.actor, source: input.source, note: input.note }, now)
      if (!decision) return undefined
      if (!input.decisionId) {
        insertPromotionDecisionRow(db, decision)
        appendWorkEventRow(db, 'promotion.decision.requested', promotionSubjectKey(decision.subjectKind, decision.subjectName), { decisionId: decision.id, action: decision.action, scorecardId: decision.scorecardId, metadata: decision.metadata }, now)
      }
      const gateId = normalizeOptionalString(input.gateId, 120) || decision.gateId
      if (!gateId) {
        const gate = insertHumanGateRow(db, promotionGateInput(decision, input), now, { force: false })
        if (gate) {
          decision.gateId = gate.id
          decision.status = 'pending'
          decision.updatedAt = now
          updatePromotionDecisionRow(db, decision)
          db.exec('COMMIT')
          return decision
        }
      } else {
        const gate = rowToHumanGate(db.prepare('SELECT * FROM human_gates WHERE id = ?').get(gateId))
        if (!gate) throw new Error('promotion human gate not found')
        if (gate.scopeKey !== promotionScopeKey(decision)) throw new Error('promotion human gate scope mismatch')
        decision.gateId = gate.id
        if (gate.status === 'rejected') decision.status = 'rejected'
        else if (gate.status !== 'approved') throw new Error('promotion human gate is not approved')
        else decision.status = 'approved'
      }
      if (decision.status === 'approved') {
        const validation = validatePromotionDecisionBeforeApply(db, decision)
        if (validation.ok) {
          decision.status = 'applied'
          projection = { subjectKind: decision.subjectKind, subjectName: decision.subjectName, state: decision.toStatus }
        } else {
          decision.status = 'rejected'
          decision.metadata = { ...(decision.metadata || {}), applyValidation: validation.metadata }
          decision.note = decision.note || validation.reason
        }
      }
      decision.actor = normalizeOptionalString(input.actor, 120) || decision.actor
      decision.source = normalizeOptionalString(input.source, 120) || decision.source
      decision.note = normalizeOptionalString(input.note, 2000) || decision.note
      decision.updatedAt = now
      updatePromotionDecisionRow(db, decision)
      appendWorkEventRow(db, decision.status === 'applied' ? 'promotion.decision.applied' : 'promotion.decision.rejected', promotionSubjectKey(decision.subjectKind, decision.subjectName), { decisionId: decision.id, gateId: decision.gateId, action: decision.action, fromStatus: decision.fromStatus, toStatus: decision.toStatus, note: decision.note, metadata: decision.metadata }, now)
      db.exec('COMMIT')
      if (projection) setConfigPromotionState(projection.subjectKind, projection.subjectName, projection.state)
      return decision
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

export function listPromotionDecisions(filter: { subjectKind?: PromotionSubjectKind; subjectName?: string } = {}, filePath = workStatePath()): PromotionDecisionRecord[] {
  return withWorkDb(filePath, db => {
    let rows = queryRows(db, 'SELECT * FROM promotion_decisions ORDER BY created_at DESC').map(rowToPromotionDecision).filter(Boolean) as PromotionDecisionRecord[]
    if (filter.subjectKind) rows = rows.filter(row => row.subjectKind === filter.subjectKind)
    if (filter.subjectName) rows = rows.filter(row => row.subjectName === filter.subjectName)
    return rows
  })
}

function normalizePromotionScorecardInput(input: PromotionScorecardInput, now: string): PromotionScorecardRecord {
  const subjectKind = normalizePromotionSubjectKind(input.subjectKind)
  const subjectName = normalizePromotionSubjectName(input.subjectName)
  const subjectRevision = normalizeOptionalString(input.subjectRevision, 160) || subjectRevisionFor(subjectKind, subjectName)
  const sourceKind = normalizePromotionSourceKind(input.sourceKind || 'manual')
  const sourceId = normalizeRequiredString(input.sourceId, 'sourceId', 200)
  const sourceVersion = normalizeOptionalString(input.sourceVersion, 120)
  const metrics = normalizePromotionMetrics(input.metrics || [])
  const thresholds = normalizePromotionThresholds(input.thresholds || [], metrics)
  const failed = thresholds.some(threshold => !threshold.passed) || metrics.some(metric => !metric.passed)
  const recommendation = normalizePromotionRecommendation(input.recommendation || (failed ? 'block' : 'promote'))
  const status = normalizePromotionState(input.status || (recommendation === 'block' ? 'blocked' : 'evaluated'))
  const record = {
    id: normalizeOptionalString(input.id, 180) || promotionScorecardId({ subjectKind, subjectName, subjectRevision, sourceKind, sourceId, sourceVersion }),
    subjectKind,
    subjectName,
    subjectRevision,
    sourceKind,
    sourceId,
    sourceVersion,
    metrics,
    thresholds,
    evidence: normalizeStringList(input.evidence || [], 2000),
    conclusion: normalizeOptionalString(input.conclusion, 2000) || (failed ? 'Promotion evidence failed one or more thresholds.' : 'Promotion evidence passed configured thresholds.'),
    recommendation,
    status,
    gateId: normalizeOptionalString(input.gateId, 120),
    createdAt: now,
    updatedAt: now,
  }
  assertPromotionSubjectExists(record.subjectKind, record.subjectName)
  return record
}

function applyRegressionGuardrails(db: DatabaseSync, scorecard: PromotionScorecardRecord): PromotionScorecardRecord {
  const regression = scorecard.regression || assessPromotionRegression(db, scorecard)
  if (regression.status !== 'blocked') return { ...scorecard, regression }
  const evidence = scorecard.evidence.includes(regression.message) ? scorecard.evidence : [...scorecard.evidence, regression.message]
  return {
    ...scorecard,
    regression,
    evidence,
    recommendation: 'block',
    status: 'blocked',
    conclusion: scorecard.conclusion.includes(regression.message) ? scorecard.conclusion : `${scorecard.conclusion} ${regression.message}`.trim(),
  }
}

function assessPromotionRegression(db: DatabaseSync, scorecard: PromotionScorecardRecord): PromotionRegressionGuardrail {
  const baseline = latestPromotedBaseline(db, scorecard.subjectKind, scorecard.subjectName)
  if (!baseline.scorecard || !baseline.decision) {
    return {
      status: 'not_applicable',
      warnThreshold: PROMOTION_REGRESSION_WARN_DELTA,
      blockThreshold: PROMOTION_REGRESSION_BLOCK_DELTA,
      message: 'Regression guardrail skipped: no previous promoted baseline scorecard is available.',
    }
  }
  const current = primaryScorePercentage(scorecard)
  const previous = primaryScorePercentage(baseline.scorecard)
  if (!current || !previous || current.metric !== previous.metric) {
    return {
      status: 'not_applicable',
      baselineScorecardId: baseline.scorecard.id,
      baselineDecisionId: baseline.decision.id,
      baselineRevision: baseline.scorecard.subjectRevision,
      warnThreshold: PROMOTION_REGRESSION_WARN_DELTA,
      blockThreshold: PROMOTION_REGRESSION_BLOCK_DELTA,
      message: 'Regression guardrail skipped: current and baseline scorecards do not expose comparable score metrics.',
    }
  }
  const delta = Math.max(0, previous.percentage - current.percentage)
  const base = {
    baselineScorecardId: baseline.scorecard.id,
    baselineDecisionId: baseline.decision.id,
    baselineRevision: baseline.scorecard.subjectRevision,
    metric: current.metric,
    baselinePercentage: previous.percentage,
    currentPercentage: current.percentage,
    delta,
    warnThreshold: PROMOTION_REGRESSION_WARN_DELTA,
    blockThreshold: PROMOTION_REGRESSION_BLOCK_DELTA,
  }
  if (delta >= PROMOTION_REGRESSION_BLOCK_DELTA) {
    return { ...base, status: 'blocked', message: `Regression guardrail blocked promotion: ${current.metric} dropped by ${formatDelta(delta)} from promoted baseline ${baseline.scorecard.id}.` }
  }
  if (delta >= PROMOTION_REGRESSION_WARN_DELTA) {
    return { ...base, status: 'warning', message: `Regression guardrail warning: ${current.metric} dropped by ${formatDelta(delta)} from promoted baseline ${baseline.scorecard.id}.` }
  }
  return { ...base, status: 'pass', message: `Regression guardrail passed against promoted baseline ${baseline.scorecard.id}.` }
}

function primaryScorePercentage(scorecard: PromotionScorecardRecord): { metric: string; percentage: number } | undefined {
  const metric = scorecard.metrics.find(row => row.id === 'arena.score') || scorecard.metrics.find(row => Number(row.maxScore) > 0)
  if (!metric || !(Number(metric.maxScore) > 0)) return undefined
  const percentage = Number(metric.score) / Number(metric.maxScore)
  return Number.isFinite(percentage) ? { metric: metric.id, percentage } : undefined
}

function latestPromotedBaseline(db: DatabaseSync, subjectKind: PromotionSubjectKind, subjectName: string): { decision?: PromotionDecisionRecord; scorecard?: PromotionScorecardRecord } {
  const decisions = (db.prepare("SELECT * FROM promotion_decisions WHERE subject_kind = ? AND subject_name = ? AND status = 'applied' AND to_status = 'promoted' ORDER BY updated_at DESC").all(subjectKind, subjectName) as any[])
    .map(rowToPromotionDecision)
    .filter(Boolean) as PromotionDecisionRecord[]
  for (const decision of decisions) {
    if (!decision.scorecardId) continue
    const scorecard = rowToPromotionScorecard(db.prepare('SELECT * FROM promotion_scorecards WHERE id = ?').get(decision.scorecardId)) || undefined
    if (scorecard && isValidPromotedBaseline(scorecard)) return { decision, scorecard }
  }
  return {}
}

function isValidPromotedBaseline(scorecard: PromotionScorecardRecord): boolean {
  return scorecard.recommendation === 'promote' && scorecard.status !== 'blocked' && scorecard.metrics.every(metric => metric.passed !== false) && scorecard.thresholds.every(threshold => threshold.passed !== false)
}

function formatDelta(delta: number): string {
  return `${Math.round(delta * 1000) / 10} percentage points`
}

function normalizePromotionMetrics(values: PromotionMetricScore[]): PromotionMetricScore[] {
  if (!Array.isArray(values)) throw new Error('metrics must be an array')
  return values.map((value, index) => {
    const score = finiteNumber(value.score, `metrics[${index}].score`)
    const maxScore = finiteNumber(value.maxScore, `metrics[${index}].maxScore`)
    return {
      id: normalizeRequiredString(value.id, `metrics[${index}].id`, 160),
      score,
      maxScore,
      passed: value.passed === true,
      diagnostic: normalizeOptionalString(value.diagnostic, 1000),
    }
  })
}

function normalizePromotionThresholds(values: Partial<PromotionThreshold>[], metrics: PromotionMetricScore[]): PromotionThreshold[] {
  if (!Array.isArray(values)) throw new Error('thresholds must be an array')
  const metricById = new Map(metrics.map(metric => [metric.id, metric]))
  return values.map((value, index) => {
    const metric = normalizeRequiredString(value.metric, `thresholds[${index}].metric`, 160)
    const scored = metricById.get(metric)
    const actualScore = finiteNumber(value.actualScore ?? scored?.score ?? 0, `thresholds[${index}].actualScore`)
    const maxScore = scored?.maxScore || 1
    const actualPercentage = finiteNumber(value.actualPercentage ?? (maxScore ? actualScore / maxScore : 0), `thresholds[${index}].actualPercentage`)
    const minScore = value.minScore === undefined ? undefined : finiteNumber(value.minScore, `thresholds[${index}].minScore`)
    const minPercentage = value.minPercentage === undefined ? undefined : finiteNumber(value.minPercentage, `thresholds[${index}].minPercentage`)
    return {
      id: normalizeOptionalString(value.id, 160) || `threshold.${metric}`,
      metric,
      minScore,
      minPercentage,
      actualScore,
      actualPercentage,
      passed: value.passed ?? ((minScore === undefined || actualScore >= minScore) && (minPercentage === undefined || actualPercentage >= minPercentage)),
    }
  })
}

function finiteNumber(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`)
  return number
}

function promotionScorecardId(input: { subjectKind: PromotionSubjectKind; subjectName: string; subjectRevision: string; sourceKind: PromotionEvidenceSourceKind; sourceId: string; sourceVersion?: string }): string {
  return `scorecard_${createHash('sha256').update(stableStringify(input)).digest('hex').slice(0, 20)}`
}

function promotionSubjectKey(kind: PromotionSubjectKind, name: string): string {
  return `${kind}:${name}`
}

function normalizePromotionSubjectKind(value: unknown): PromotionSubjectKind {
  if (value === 'profile' || value === 'team') return value
  throw new Error(`promotion subject kind must be profile or team: ${String(value)}`)
}

function normalizePromotionSourceKind(value: unknown): PromotionEvidenceSourceKind {
  if (value === 'arena' || value === 'eval' || value === 'manual') return value
  throw new Error(`promotion source kind must be arena, eval, or manual: ${String(value)}`)
}

function normalizePromotionRecommendation(value: unknown): PromotionRecommendation {
  if (value === 'promote' || value === 'hold' || value === 'block' || value === 'deprecate') return value
  throw new Error(`promotion recommendation must be promote, hold, block, or deprecate: ${String(value)}`)
}

function normalizePromotionAction(value: unknown): PromotionAction {
  if (value === 'promote' || value === 'deprecate' || value === 'rollback' || value === 'block') return value
  throw new Error(`promotion action must be promote, deprecate, rollback, or block: ${String(value)}`)
}

function normalizePromotionState(value: unknown): AgentPromotionState {
  if (value === 'draft' || value === 'evaluated' || value === 'promoted' || value === 'deprecated' || value === 'blocked') return value
  throw new Error(`promotion state must be draft, evaluated, promoted, deprecated, or blocked: ${String(value)}`)
}

function normalizePromotionDecisionStatus(value: unknown): PromotionDecisionStatus | undefined {
  return ['pending', 'approved', 'rejected', 'applied'].includes(String(value)) ? value as PromotionDecisionStatus : undefined
}

function normalizePromotionSubjectName(value: unknown): string {
  const name = normalizeRequiredString(value, 'subjectName', 128)
  if (!/^[a-zA-Z0-9_.:/-]+$/.test(name)) throw new Error(`promotion subject name contains invalid characters: ${name}`)
  return name
}

function subjectRevisionFor(kind: PromotionSubjectKind, name: string): string {
  const config = getConfig()
  if (kind === 'team') {
    const team = config.agentTeams[name]
    if (!team) throw new Error(`agent team not found: ${name}`)
    const { revision: _revision, promotionState: _promotionState, ...revisionInput } = team
    return createHash('sha256').update(stableStringify(revisionInput)).digest('hex').slice(0, 16)
  }
  const profile = config.profiles[name]
  if (!profile) throw new Error(`profile not found: ${name}`)
  const { promotionState: _promotionState, ...revisionInput } = profile
  return createHash('sha256').update(stableStringify(revisionInput)).digest('hex').slice(0, 16)
}

function assertPromotionSubjectExists(kind: PromotionSubjectKind, name: string): void {
  void subjectRevisionFor(kind, name)
}

function configPromotionState(kind: PromotionSubjectKind, name: string): AgentPromotionState | undefined {
  const config = getConfig()
  return kind === 'team' ? config.agentTeams[name]?.promotionState : config.profiles[name]?.promotionState
}

function setConfigPromotionState(kind: PromotionSubjectKind, name: string, state: AgentPromotionState): void {
  const config = getConfig()
  if (kind === 'team') {
    const team = config.agentTeams[name]
    if (!team) throw new Error(`agent team not found: ${name}`)
    updateConfig({ agentTeams: { ...config.agentTeams, [name]: { ...team, promotionState: state } } } as any)
    return
  }
  const profile = config.profiles[name]
  if (!profile) throw new Error(`profile not found: ${name}`)
  updateConfig({ profiles: { ...config.profiles, [name]: { ...profile, promotionState: state } } } as any)
}

function applyEvaluatedPromotionProjection(scorecard: PromotionScorecardRecord): void {
  const current = configPromotionState(scorecard.subjectKind, scorecard.subjectName)
  if ((current === undefined || current === 'draft') && (scorecard.status === 'evaluated' || scorecard.status === 'blocked')) {
    setConfigPromotionState(scorecard.subjectKind, scorecard.subjectName, scorecard.status)
  }
}

function promotionRollbackEligibilityFromDb(db: DatabaseSync, subjectKind: PromotionSubjectKind, subjectName: string, currentState = getPromotionStateFromDb(db, subjectKind, subjectName).state): PromotionRollbackEligibility {
  if (currentState === 'promoted' || currentState === 'evaluated' || currentState === 'draft') {
    return { eligible: false, status: 'not_needed', reason: `rollback is not needed while promotion state is ${currentState}` }
  }
  const baseline = latestPromotedBaseline(db, subjectKind, subjectName)
  if (!baseline.decision || !baseline.scorecard) return { eligible: false, status: 'no_baseline', reason: 'rollback requires a previous applied promoted baseline with scorecard evidence' }
  if (!isValidPromotedBaseline(baseline.scorecard)) return { eligible: false, status: 'invalid_baseline', reason: `baseline scorecard is not a valid promoted baseline: ${baseline.scorecard.id}` }
  const subjectSafety = validateRollbackSubjectSafety(subjectKind, subjectName, baseline.scorecard.subjectRevision)
  if (subjectSafety.status !== 'eligible') {
    return {
      eligible: false,
      status: subjectSafety.status,
      targetStatus: 'promoted',
      baselineDecisionId: baseline.decision.id,
      baselineScorecardId: baseline.scorecard.id,
      baselineRevision: baseline.scorecard.subjectRevision,
      reason: subjectSafety.reason,
    }
  }
  return {
    eligible: true,
    status: 'eligible',
    targetStatus: 'promoted',
    baselineDecisionId: baseline.decision.id,
    baselineScorecardId: baseline.scorecard.id,
    baselineRevision: baseline.scorecard.subjectRevision,
    reason: `rollback can restore promoted baseline ${baseline.scorecard.id}`,
  }
}

function validateRollbackSubjectSafety(subjectKind: PromotionSubjectKind, subjectName: string, baselineRevision: string): Pick<PromotionRollbackEligibility, 'status' | 'reason'> {
  const config = getConfig()
  try {
    if (subjectKind === 'profile') {
      const profile = config.profiles[subjectName]
      if (!profile) return { status: 'missing_subject', reason: `profile not found: ${subjectName}` }
      validateProfileConfig(subjectName, profile)
      const unsafe = unsafeProfilePromotionReason(profile)
      if (unsafe) return { status: 'unsafe_subject', reason: unsafe }
    } else {
      const team = config.agentTeams[subjectName]
      if (!team) return { status: 'missing_subject', reason: `agent team not found: ${subjectName}` }
      validateAgentTeamConfig(subjectName, team, config.profiles)
      const unsafe = unsafeTeamPromotionReason(team, config.profiles)
      if (unsafe) return { status: 'unsafe_subject', reason: unsafe }
    }
    const currentRevision = subjectRevisionFor(subjectKind, subjectName)
    if (currentRevision !== baselineRevision) return { status: 'revision_mismatch', reason: `current ${subjectKind} revision ${currentRevision} does not match promoted baseline revision ${baselineRevision}; rollback cannot restore config snapshots` }
    return { status: 'eligible', reason: 'rollback target is present, valid, and matches the promoted baseline revision' }
  } catch (err: any) {
    return { status: 'invalid_baseline', reason: err?.message || String(err) }
  }
}

function unsafeTeamPromotionReason(team: AgentTeamConfig, profiles: Record<string, AgentProfile>): string | undefined {
  for (const profileName of new Set(Object.values(team.roles || {}).filter(Boolean))) {
    const profile = profiles[String(profileName)]
    if (!profile) return `team references missing profile: ${String(profileName)}`
    const unsafe = unsafeProfilePromotionReason(profile)
    if (unsafe) return `team profile ${String(profileName)} is unsafe: ${unsafe}`
  }
  return undefined
}

function unsafeProfilePromotionReason(profile: AgentProfile): string | undefined {
  for (const [key, value] of Object.entries(profile.permission || {})) {
    if (value === 'allow' && UNSAFE_PROMOTION_ALLOW_KEYS.has(key)) return `unsafe broad permission grant must not be allow: ${key || '(default)'}`
  }
  return undefined
}

function promotionActionTargetStatus(action: PromotionAction, fromStatus: AgentPromotionState): AgentPromotionState {
  if (action === 'promote' || action === 'rollback') return 'promoted'
  if (action === 'deprecate') return 'deprecated'
  if (action === 'block') return 'blocked'
  return fromStatus
}

function promotionScopeKey(decision: Pick<PromotionDecisionRecord, 'subjectKind' | 'subjectName' | 'action' | 'scorecardId'>): string {
  return `promotion:${decision.action}:${decision.subjectKind}:${decision.subjectName}:${decision.scorecardId || 'manual'}`
}

function promotionGateInput(decision: PromotionDecisionRecord, input: { actor?: string; note?: string }): HumanGateInput {
  return {
    type: 'manual',
    reason: `Approve ${decision.action} for ${decision.subjectKind} ${decision.subjectName}`,
    requestedBy: normalizeOptionalString(input.actor, 120) || decision.actor || 'gateway.promotion',
    scopeKey: promotionScopeKey(decision),
    details: { operation: decision.action, subjectKind: decision.subjectKind, subjectName: decision.subjectName, scorecardId: decision.scorecardId, fromStatus: decision.fromStatus, toStatus: decision.toStatus, note: input.note || decision.note, metadata: decision.metadata },
  }
}

function validatePromotionDecisionBeforeApply(db: DatabaseSync, decision: PromotionDecisionRecord): { ok: true } | { ok: false; reason: string; metadata: Record<string, unknown> } {
  if (decision.action === 'rollback') {
    const currentState = getPromotionStateFromDb(db, decision.subjectKind, decision.subjectName).state
    const rollback = promotionRollbackEligibilityFromDb(db, decision.subjectKind, decision.subjectName, currentState)
    if (!rollback.eligible) return promotionApplyRejection(`promotion rollback is not eligible: ${rollback.reason}`, { rollback })
    if (decision.scorecardId && decision.scorecardId !== rollback.baselineScorecardId) {
      const rejectedRollback: PromotionRollbackEligibility = {
        ...rollback,
        eligible: false,
        status: 'invalid_baseline',
        reason: `rollback decision scorecard ${decision.scorecardId} no longer matches eligible baseline ${rollback.baselineScorecardId || '(none)'}`,
      }
      return promotionApplyRejection(`promotion rollback is not eligible: ${rejectedRollback.reason}`, { rollback: rejectedRollback })
    }
    decision.scorecardId ||= rollback.baselineScorecardId
    decision.metadata = { ...(decision.metadata || {}), rollback }
    return { ok: true }
  }

  if (decision.action === 'promote' && decision.scorecardId) {
    const scorecard = rowToPromotionScorecard(db.prepare('SELECT * FROM promotion_scorecards WHERE id = ?').get(decision.scorecardId)) || undefined
    const reason = scorecardPromotionBlockedReason(scorecard, decision.scorecardId)
    if (reason) return promotionApplyRejection(reason, { scorecardId: decision.scorecardId })
  }

  return { ok: true }
}

function scorecardPromotionBlockedReason(scorecard: PromotionScorecardRecord | undefined, scorecardId: string): string | undefined {
  if (!scorecard) return `promotion scorecard not found: ${scorecardId}`
  if (scorecard.status === 'blocked' || scorecard.recommendation === 'block' || scorecard.regression?.status === 'blocked') return `promotion scorecard is blocked and cannot be promoted: ${scorecard.id}`
  return undefined
}

function promotionApplyRejection(reason: string, metadata: Record<string, unknown>): { ok: false; reason: string; metadata: Record<string, unknown> } {
  return { ok: false, reason, metadata: { status: 'rejected', reason, ...metadata } }
}

function buildPromotionDecisionRecord(db: DatabaseSync, input: { subjectKind: PromotionSubjectKind; subjectName: string; action: PromotionAction; scorecardId?: string; gateId?: string; actor?: string; source?: string; note?: string }, now: string): PromotionDecisionRecord {
  const subjectKind = normalizePromotionSubjectKind(input.subjectKind)
  const subjectName = normalizePromotionSubjectName(input.subjectName)
  const subjectRevision = subjectRevisionFor(subjectKind, subjectName)
  const action = normalizePromotionAction(input.action)
  const fromStatus = getPromotionStateFromDb(db, subjectKind, subjectName).state
  const toStatus = promotionActionTargetStatus(action, fromStatus)
  let scorecardId = normalizeOptionalString(input.scorecardId, 160)
  const metadata: Record<string, unknown> = {}
  if (action === 'rollback') {
    const rollback = promotionRollbackEligibilityFromDb(db, subjectKind, subjectName, fromStatus)
    if (!rollback.eligible) throw new Error(`promotion rollback is not eligible: ${rollback.reason}`)
    if (scorecardId && scorecardId !== rollback.baselineScorecardId) {
      throw new Error(`promotion rollback scorecardId must match the selected eligible baseline ${rollback.baselineScorecardId}: received ${scorecardId}`)
    }
    scorecardId = rollback.baselineScorecardId
    metadata['rollback'] = rollback
  }
  const scorecard = scorecardId ? rowToPromotionScorecard(db.prepare('SELECT * FROM promotion_scorecards WHERE id = ?').get(scorecardId)) || undefined : undefined
  if (scorecardId && !scorecard) throw new Error(`promotion scorecard not found: ${scorecardId}`)
  const blockedReason = action === 'promote' && scorecardId ? scorecardPromotionBlockedReason(scorecard, scorecardId) : undefined
  if (blockedReason) throw new Error(blockedReason)
  return {
    id: `promotion_${randomUUID()}`,
    subjectKind,
    subjectName,
    subjectRevision,
    action,
    fromStatus,
    toStatus,
    scorecardId,
    gateId: normalizeOptionalString(input.gateId, 120),
    status: 'pending',
    actor: normalizeOptionalString(input.actor, 120),
    source: normalizeOptionalString(input.source, 120),
    note: normalizeOptionalString(input.note, 2000),
    metadata,
    createdAt: now,
    updatedAt: now,
  }
}

function getPromotionStateFromDb(db: DatabaseSync, subjectKind: PromotionSubjectKind, subjectName: string): { state: AgentPromotionState; scorecard?: PromotionScorecardRecord; decision?: PromotionDecisionRecord } {
  const scorecard = rowToPromotionScorecard(db.prepare('SELECT * FROM promotion_scorecards WHERE subject_kind = ? AND subject_name = ? ORDER BY updated_at DESC LIMIT 1').get(subjectKind, subjectName)) || undefined
  const decision = rowToPromotionDecision(db.prepare("SELECT * FROM promotion_decisions WHERE subject_kind = ? AND subject_name = ? AND status = 'applied' ORDER BY updated_at DESC LIMIT 1").get(subjectKind, subjectName)) || undefined
  return { state: decision?.toStatus || scorecard?.status || configPromotionState(subjectKind, subjectName) || 'draft', scorecard, decision }
}

function insertPromotionDecisionRow(db: DatabaseSync, record: PromotionDecisionRecord): void {
  db.prepare(`INSERT INTO promotion_decisions (
    id, subject_kind, subject_name, subject_revision, action, from_status, to_status, scorecard_id, gate_id, status, actor, source, note, metadata_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.id,
    record.subjectKind,
    record.subjectName,
    record.subjectRevision,
    record.action,
    record.fromStatus,
    record.toStatus,
    record.scorecardId || null,
    record.gateId || null,
    record.status,
    record.actor || null,
    record.source || null,
    record.note || null,
    JSON.stringify(record.metadata || {}),
    record.createdAt,
    record.updatedAt,
  )
}

function updatePromotionDecisionRow(db: DatabaseSync, record: PromotionDecisionRecord): void {
  db.prepare(`UPDATE promotion_decisions SET scorecard_id = ?, gate_id = ?, status = ?, actor = ?, source = ?, note = ?, metadata_json = ?, updated_at = ? WHERE id = ?`)
    .run(record.scorecardId || null, record.gateId || null, record.status, record.actor || null, record.source || null, record.note || null, JSON.stringify(record.metadata || {}), record.updatedAt, record.id)
}

function rowToPromotionScorecard(row: any): PromotionScorecardRecord | null {
  if (!row?.id) return null
  const subjectKind = row.subject_kind === 'profile' || row.subject_kind === 'team' ? row.subject_kind as PromotionSubjectKind : undefined
  const sourceKind = row.source_kind === 'arena' || row.source_kind === 'eval' || row.source_kind === 'manual' ? row.source_kind as PromotionEvidenceSourceKind : undefined
  const recommendation = ['promote', 'hold', 'block', 'deprecate'].includes(row.recommendation) ? row.recommendation as PromotionRecommendation : undefined
  const status = ['draft', 'evaluated', 'promoted', 'deprecated', 'blocked'].includes(row.status) ? row.status as AgentPromotionState : undefined
  if (!subjectKind || !sourceKind || !recommendation || !status) return null
  return {
    id: String(row.id),
    subjectKind,
    subjectName: String(row.subject_name || ''),
    subjectRevision: String(row.subject_revision || ''),
    sourceKind,
    sourceId: String(row.source_id || ''),
    sourceVersion: row.source_version || undefined,
    metrics: parseJSON(row.metrics_json, []),
    thresholds: parseJSON(row.thresholds_json, []),
    evidence: parseJSON(row.evidence_json, []),
    conclusion: String(row.conclusion || ''),
    recommendation,
    status,
    regression: row.regression_json ? parseJSON(row.regression_json, undefined) : undefined,
    gateId: row.gate_id || undefined,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function rowToPromotionDecision(row: any): PromotionDecisionRecord | null {
  if (!row?.id) return null
  const subjectKind = row.subject_kind === 'profile' || row.subject_kind === 'team' ? row.subject_kind as PromotionSubjectKind : undefined
  const action = ['promote', 'deprecate', 'rollback', 'block'].includes(row.action) ? row.action as PromotionAction : undefined
  const fromStatus = ['draft', 'evaluated', 'promoted', 'deprecated', 'blocked'].includes(row.from_status) ? row.from_status as AgentPromotionState : undefined
  const toStatus = ['draft', 'evaluated', 'promoted', 'deprecated', 'blocked'].includes(row.to_status) ? row.to_status as AgentPromotionState : undefined
  const status = normalizePromotionDecisionStatus(row.status)
  if (!subjectKind || !action || !fromStatus || !toStatus || !status) return null
  return {
    id: String(row.id),
    subjectKind,
    subjectName: String(row.subject_name || ''),
    subjectRevision: String(row.subject_revision || ''),
    action,
    fromStatus,
    toStatus,
    scorecardId: row.scorecard_id || undefined,
    gateId: row.gate_id || undefined,
    status,
    actor: row.actor || undefined,
    source: row.source || undefined,
    note: row.note || undefined,
    metadata: row.metadata_json ? parseJSON(row.metadata_json, {}) : {},
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}
