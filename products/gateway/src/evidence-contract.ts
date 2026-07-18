import { createHash } from 'node:crypto'

export type EvidenceClaimState =
  | 'local_beta_evidence_only'
  | 'local_beta_support_diagnosis_only'
  | 'local_admin_unredacted_only'
  | 'no_release_claim_expansion'
  | 'release_review_blocked'

export type EvidenceClaimEffect =
  | 'local_evidence_integrity_only'
  | 'local_ux_truth_only'
  | 'execution_reliability_only'
  | 'decision_record_only'
  | 'no_release_claim_expansion'

export type EvidenceRedactionState =
  | 'redacted'
  | 'share_safe'
  | 'unredacted_local_admin_only'
  | 'blocked'

export type EvidenceValidationState = 'pass' | 'warn' | 'fail'
export type EvidenceResidualRiskState = 'open' | 'accepted' | 'blocked' | 'deferred' | 'waived'
export type EvidenceProofState =
  | 'proven_current'
  | 'supported_bounded'
  | 'ready_for_proof'
  | 'blocked'
  | 'deferred'
  | 'waived'
  | 'fixture_only'
export type EvidenceProofMode = 'live' | 'fixture' | 'dry_run' | 'local_state' | 'decision_record'
export type EvidencePipelineV2Surface = 'evidence_export' | 'proof_run' | 'support_diagnosis' | 'incident_bundle' | 'release_decision'
export type EvidencePipelineV2Status = 'pass' | 'warn' | 'fail'
export type EvidencePipelineDecisionState = 'no_decision' | 'decision_supported' | 'decision_blocked' | 'decision_deferred'
export type EvidencePipelineClaimChange = 'no_release_claim_expansion' | 'advance_requested' | 'advance_approved' | 'blocked' | 'deferred'

export interface EvidenceContractRef {
  ref: string
  kind: string
  redacted: boolean
}

export interface EvidenceContractFailure {
  code: string
  summary: string
  safeNextAction: string
}

export interface EvidenceResidualRiskEntry {
  id: string
  state: EvidenceResidualRiskState
  summary: string
  safeNextAction: string
}

export interface EvidenceProofContractInput {
  state: EvidenceProofState
  mode: EvidenceProofMode
  summary: string
  safeNextAction: string
  evidenceRefs?: string[]
}

export interface EvidenceProofContract {
  state: EvidenceProofState
  mode: EvidenceProofMode
  summary: string
  safeNextAction: string
  evidenceRefs: EvidenceContractRef[]
}

export interface EvidenceContractInput {
  claim: {
    state: EvidenceClaimState
    effect: EvidenceClaimEffect
    publicClaim: string
    boundary: string
    unsupportedClaims?: string[]
  }
  redaction: {
    state: EvidenceRedactionState
    safeToShare: boolean
    rules: string[]
    safeNextAction?: string
  }
  proof?: EvidenceProofContractInput
  evidenceRefs?: string[]
  residualRisks?: EvidenceResidualRiskEntry[]
  rawTextSamples?: string[]
  generatedAt?: string
}

export interface EvidenceContractEnvelope {
  schemaVersion: 1
  generatedAt: string
  claimState: EvidenceClaimState
  claim: {
    state: EvidenceClaimState
    effect: EvidenceClaimEffect
    publicClaim: string
    boundary: string
    unsupportedClaims: string[]
  }
  redaction: {
    state: EvidenceRedactionState
    safeToShare: boolean
    rules: string[]
    safeNextAction: string
  }
  proof: EvidenceProofContract
  evidenceRefs: EvidenceContractRef[]
  residualRisks: EvidenceResidualRiskEntry[]
  validation: {
    state: EvidenceValidationState
    failures: EvidenceContractFailure[]
    safeNextAction: string
  }
}

export interface EvidenceContractStateSummary {
  claimState: EvidenceClaimState
  claimEffect: EvidenceClaimEffect
  proofState: EvidenceProofState
  proofMode: EvidenceProofMode
  redactionState: EvidenceRedactionState
  validationState: EvidenceValidationState
  safeToShare: boolean
  safeNextAction: string
  evidenceRefs: string[]
  residualRiskStates: EvidenceResidualRiskState[]
  unsupportedClaims: string[]
}

export interface EvidencePipelineV2DecisionInput {
  state?: EvidencePipelineDecisionState
  claimChange?: EvidencePipelineClaimChange
  claimEffect?: EvidenceClaimEffect
  summary?: string
  safeNextAction?: string
  evidenceRefs?: string[]
}

export interface EvidencePipelineV2Decision {
  state: EvidencePipelineDecisionState
  claimChange: EvidencePipelineClaimChange
  claimEffect: EvidenceClaimEffect
  summary: string
  safeNextAction: string
  evidenceRefs: EvidenceContractRef[]
}

export interface EvidencePipelineV2Report {
  schemaVersion: 1
  mode: 'm41_evidence_pipeline_v2'
  owner: 'evidence-contract'
  generatedAt: string
  surface: EvidencePipelineV2Surface
  status: EvidencePipelineV2Status
  releaseClaimBoundary: 'local_beta_evidence_pipeline_only_no_release_claim_expansion'
  summary: string
  contractCount: number
  counts: {
    claimStates: Record<string, number>
    claimEffects: Record<string, number>
    proofStates: Record<string, number>
    proofModes: Record<string, number>
    redactionStates: Record<string, number>
    validationStates: Record<string, number>
    residualRiskStates: Record<string, number>
    evidenceRefs: number
    redactedRefs: number
    unsupportedClaims: number
    failures: number
  }
  decision: EvidencePipelineV2Decision
  acceptance: {
    ownerDocumented: true
    contractsPresent: boolean
    validationGatePass: boolean
    redactionGatePass: boolean
    evidenceRefsGatePass: boolean
    decisionGatePass: boolean
    compatibilityReadable: true
    noReleaseClaimExpansion: boolean
  }
  errors: string[]
  warnings: string[]
  safeNextAction: string
  unsupportedClaims: string[]
}

export interface EvidencePipelineV2Input {
  surface: EvidencePipelineV2Surface
  contracts: EvidenceContractEnvelope[]
  decision?: EvidencePipelineV2DecisionInput
  generatedAt?: string
}

export const EVIDENCE_CONTRACT_SAFE_NEXT_ACTION = 'Regenerate this evidence through a redacted Gateway evidence export or support diagnosis path before sharing or using it for a decision.'
export const EVIDENCE_PROOF_SAFE_NEXT_ACTION = 'Attach bounded proof evidence or record the missing proof blocker before using this contract for a decision.'

const CLAIM_STATES: EvidenceClaimState[] = [
  'local_beta_evidence_only',
  'local_beta_support_diagnosis_only',
  'local_admin_unredacted_only',
  'no_release_claim_expansion',
  'release_review_blocked',
]

const CLAIM_EFFECTS: EvidenceClaimEffect[] = [
  'local_evidence_integrity_only',
  'local_ux_truth_only',
  'execution_reliability_only',
  'decision_record_only',
  'no_release_claim_expansion',
]

const REDACTION_STATES: EvidenceRedactionState[] = [
  'redacted',
  'share_safe',
  'unredacted_local_admin_only',
  'blocked',
]

const RESIDUAL_RISK_STATES: EvidenceResidualRiskState[] = ['open', 'accepted', 'blocked', 'deferred', 'waived']
const PROOF_STATES: EvidenceProofState[] = ['proven_current', 'supported_bounded', 'ready_for_proof', 'blocked', 'deferred', 'waived', 'fixture_only']
const PROOF_MODES: EvidenceProofMode[] = ['live', 'fixture', 'dry_run', 'local_state', 'decision_record']
const UNSUPPORTED_PUBLIC_CLAIM_PATTERN = /\b(production[- ]?ready|production certified|release[- ]?candidate ready|hosted[- /]?team ready|whatsapp[- ]?live ready|universal[- ]?channel ready|arbitrary[- ]?scale ready|multi[- ]?tenant[- ]?saas ready)\b/i
const SECRET_PATTERN = /\b(Bearer\s+[A-Za-z0-9._~+/-]+|token\s*[=:]\s*\S+|secret\s*[=:]\s*\S+|password\s*[=:]\s*\S+|credential\s*[=:]\s*\S+|\d{6,}:[A-Za-z0-9_-]{20,})\b/i
const RAW_CHANNEL_ID_PATTERN = /\b\d{10,16}\b/
const PRIVATE_TEXT_PATTERN = /\b(private transcript body|private channel content|raw transcript text|sensitive prompt text)\b/i
const PRIVATE_PATH_PATTERN = /(?:^|[\s:=])(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/)/
const REDACTED_REF_PATTERN = /^<redacted:ref:[a-f0-9]{12}>$/
const DOC_REF_PATTERN = /^docs\/[A-Za-z0-9._/-]+$/
const TYPED_REF_PATTERN = /^[a-z][a-z0-9_.-]*:[A-Za-z0-9_.<>{}\-/:=@]+$/i

export function buildEvidenceContract(input: EvidenceContractInput): EvidenceContractEnvelope {
  const generatedAt = input.generatedAt || new Date().toISOString()
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs || [])
  const redactionSafeNextAction = input.redaction.safeNextAction || EVIDENCE_CONTRACT_SAFE_NEXT_ACTION
  const proof = buildProofContract(input, evidenceRefs)
  const envelope: EvidenceContractEnvelope = {
    schemaVersion: 1,
    generatedAt,
    claimState: input.claim.state,
    claim: {
      state: input.claim.state,
      effect: input.claim.effect,
      publicClaim: input.claim.publicClaim,
      boundary: input.claim.boundary,
      unsupportedClaims: [...(input.claim.unsupportedClaims || [])],
    },
    redaction: {
      state: input.redaction.state,
      safeToShare: input.redaction.safeToShare,
      rules: [...input.redaction.rules],
      safeNextAction: redactionSafeNextAction,
    },
    proof,
    evidenceRefs,
    residualRisks: [...(input.residualRisks || [])],
    validation: {
      state: 'pass',
      failures: [],
      safeNextAction: redactionSafeNextAction,
    },
  }
  envelope.validation = validateEvidenceContract(envelope, input.rawTextSamples || [])
  return envelope
}

export function validateEvidenceContract(contract: EvidenceContractEnvelope, rawTextSamples: string[] = []): EvidenceContractEnvelope['validation'] {
  const failures: EvidenceContractFailure[] = []
  const fail = (code: string, summary: string, safeNextAction = EVIDENCE_CONTRACT_SAFE_NEXT_ACTION) => failures.push({ code, summary, safeNextAction })

  if (contract.schemaVersion !== 1) fail('unsupported_schema_version', 'Evidence contract schemaVersion must be 1.')
  if (!CLAIM_STATES.includes(contract.claim.state)) fail('missing_or_unsupported_claim_state', 'Evidence contract claim.state is missing or unsupported.')
  if (contract.claimState !== contract.claim.state) fail('claim_state_mismatch', 'Evidence contract claimState must match claim.state.')
  if (!CLAIM_EFFECTS.includes(contract.claim.effect)) fail('missing_or_unsupported_claim_effect', 'Evidence contract claim.effect is missing or unsupported.')
  if (!contract.claim.publicClaim || unsupportedPublicClaim(contract.claim.publicClaim)) {
    fail('unsupported_public_wording', 'Evidence contract publicClaim is missing or implies an unsupported release or production claim.')
  }
  if (!contract.claim.boundary || unsupportedPublicClaim(contract.claim.boundary)) {
    fail('unsupported_claim_boundary', 'Evidence contract boundary is missing or implies an unsupported release or production claim.')
  }
  if (containsUnsafeEvidenceText(`${contract.claim.publicClaim} ${contract.claim.boundary}`)) {
    fail('unsafe_claim_text', 'Evidence contract claim text contains private, provider-target, credential, or local path material.')
  }
  if (!REDACTION_STATES.includes(contract.redaction.state)) fail('missing_or_unsupported_redaction_state', 'Evidence contract redaction.state is missing or unsupported.')
  if (!Array.isArray(contract.redaction.rules) || contract.redaction.rules.length === 0) fail('missing_redaction_rules', 'Evidence contract must list the active redaction rules.')
  if (contract.redaction.state === 'blocked' || !contract.redaction.safeToShare) {
    fail('redaction_not_share_safe', 'Evidence contract redaction state is not share safe.', contract.redaction.safeNextAction || EVIDENCE_CONTRACT_SAFE_NEXT_ACTION)
  }
  if (!PROOF_STATES.includes(contract.proof?.state)) fail('missing_or_unsupported_proof_state', 'Evidence contract proof.state is missing or unsupported.')
  if (!PROOF_MODES.includes(contract.proof?.mode)) fail('missing_or_unsupported_proof_mode', 'Evidence contract proof.mode is missing or unsupported.')
  if (!contract.proof?.summary || containsUnsafeEvidenceText(contract.proof.summary)) fail('unsafe_or_missing_proof_summary', 'Evidence contract proof.summary is missing or unsafe.')
  if (!contract.proof?.safeNextAction || containsUnsafeEvidenceText(contract.proof.safeNextAction)) fail('unsafe_or_missing_proof_next_action', 'Evidence contract proof.safeNextAction is missing or unsafe.')
  for (const ref of contract.proof?.evidenceRefs || []) {
    if (!isWellFormedEvidenceRef(ref.ref)) fail('malformed_proof_evidence_ref', `Proof evidence ref is malformed or unsafe: ${safeFailureRef(ref.ref)}`)
  }

  for (const ref of contract.evidenceRefs) {
    if (!isWellFormedEvidenceRef(ref.ref)) fail('malformed_evidence_ref', `Evidence ref is malformed or unsafe: ${ref.ref}`)
    if (containsUnsafeEvidenceText(ref.ref)) fail('unsafe_evidence_ref', `Evidence ref contains raw private or credential-like material: ${safeFailureRef(ref.ref)}`)
  }
  for (const sample of rawTextSamples) {
    if (containsUnsafeEvidenceText(sample)) fail('unsafe_raw_text_sample', 'Raw evidence text contains private transcript, credential, provider target, or private path material.')
  }
  for (const risk of contract.residualRisks) {
    if (!risk.id || !risk.summary || !risk.safeNextAction || !RESIDUAL_RISK_STATES.includes(risk.state)) {
      fail('malformed_residual_risk', `Residual-risk entry is malformed: ${risk.id || '<missing-id>'}`)
    }
    if (containsUnsafeEvidenceText(`${risk.summary} ${risk.safeNextAction}`)) {
      fail('unsafe_residual_risk_text', `Residual-risk entry contains unsafe text: ${risk.id || '<missing-id>'}`)
    }
  }

  return {
    state: failures.length ? 'fail' : 'pass',
    failures,
    safeNextAction: failures.find(failure => failure.code === 'redaction_not_share_safe')?.safeNextAction || failures[0]?.safeNextAction || 'Evidence contract passed; keep using redacted contract data for rendering and decisions.',
  }
}

export function summarizeEvidenceContractState(contract: EvidenceContractEnvelope): EvidenceContractStateSummary {
  return {
    claimState: contract.claimState,
    claimEffect: contract.claim.effect,
    proofState: contract.proof.state,
    proofMode: contract.proof.mode,
    redactionState: contract.redaction.state,
    validationState: contract.validation.state,
    safeToShare: contract.redaction.safeToShare,
    safeNextAction: contract.validation.safeNextAction,
    evidenceRefs: contract.evidenceRefs.map(ref => ref.ref),
    residualRiskStates: uniqueStrings(contract.residualRisks.map(risk => risk.state)) as EvidenceResidualRiskState[],
    unsupportedClaims: [...contract.claim.unsupportedClaims],
  }
}

export function buildEvidencePipelineV2(input: EvidencePipelineV2Input): EvidencePipelineV2Report {
  const contracts = [...input.contracts]
  const generatedAt = input.generatedAt || contracts[0]?.generatedAt || new Date().toISOString()
  const evidenceRefs = contracts.flatMap(contract => contract.evidenceRefs)
  const proofRefs = contracts.flatMap(contract => contract.proof.evidenceRefs)
  const unsupportedClaims = uniqueStrings(contracts.flatMap(contract => contract.claim.unsupportedClaims))
  const validationFailures = contracts.flatMap(contract => contract.validation.failures)
  const decision = buildPipelineDecision(input.decision, contracts, generatedAt)
  const allRefs = [...evidenceRefs, ...proofRefs, ...decision.evidenceRefs]
  const claimAdvanceRequested = decision.claimChange === 'advance_requested' || decision.claimChange === 'advance_approved'
  const redactionGatePass = contracts.every(contract => contract.redaction.safeToShare && contract.redaction.state !== 'blocked')
  const validationGatePass = contracts.every(contract => contract.validation.state === 'pass')
  const evidenceRefsGatePass = allRefs.length > 0 && allRefs.every(ref => isWellFormedEvidenceRef(ref.ref))
  const unsafeDecisionText = containsUnsafeEvidenceText(`${decision.summary} ${decision.safeNextAction}`)
    || unsupportedPublicClaim(`${decision.summary} ${decision.safeNextAction}`)
  const decisionGatePass = !claimAdvanceRequested
    || (decision.state === 'decision_supported' && validationGatePass && redactionGatePass && evidenceRefsGatePass && unsupportedClaims.length === 0 && !unsafeDecisionText)
  const noReleaseClaimExpansion = decision.claimChange === 'no_release_claim_expansion' || decision.claimChange === 'blocked' || decision.claimChange === 'deferred'
  const acceptance = {
    ownerDocumented: true as const,
    contractsPresent: contracts.length > 0,
    validationGatePass,
    redactionGatePass,
    evidenceRefsGatePass,
    decisionGatePass,
    compatibilityReadable: true as const,
    noReleaseClaimExpansion,
  }
  const errors = [
    ...(acceptance.contractsPresent ? [] : ['contracts_missing']),
    ...(acceptance.validationGatePass ? [] : ['validation_gate_failed']),
    ...(acceptance.redactionGatePass ? [] : ['redaction_gate_failed']),
    ...(acceptance.evidenceRefsGatePass ? [] : ['evidence_ref_gate_failed']),
    ...(acceptance.decisionGatePass ? [] : ['decision_gate_failed']),
    ...(unsafeDecisionText ? ['unsafe_decision_text'] : []),
    ...(claimAdvanceRequested && unsupportedClaims.length ? ['release_claim_advance_has_unsupported_claims'] : []),
  ]
  const warnings = [
    ...uniqueStrings(contracts.flatMap(contract => contract.residualRisks.map(risk => risk.state === 'accepted' ? '' : `residual_risk_${risk.state}`))),
  ]
  const status: EvidencePipelineV2Status = errors.length ? 'fail' : warnings.length ? 'warn' : 'pass'
  const counts = {
    claimStates: countBy(contracts.map(contract => contract.claim.state)),
    claimEffects: countBy(contracts.map(contract => contract.claim.effect)),
    proofStates: countBy(contracts.map(contract => contract.proof.state)),
    proofModes: countBy(contracts.map(contract => contract.proof.mode)),
    redactionStates: countBy(contracts.map(contract => contract.redaction.state)),
    validationStates: countBy(contracts.map(contract => contract.validation.state)),
    residualRiskStates: countBy(contracts.flatMap(contract => contract.residualRisks.map(risk => risk.state))),
    evidenceRefs: allRefs.length,
    redactedRefs: allRefs.filter(ref => ref.redacted).length,
    unsupportedClaims: unsupportedClaims.length,
    failures: validationFailures.length,
  }
  return {
    schemaVersion: 1,
    mode: 'm41_evidence_pipeline_v2',
    owner: 'evidence-contract',
    generatedAt,
    surface: input.surface,
    status,
    releaseClaimBoundary: 'local_beta_evidence_pipeline_only_no_release_claim_expansion',
    summary: pipelineSummary(status, input.surface, counts, decision),
    contractCount: contracts.length,
    counts,
    decision,
    acceptance,
    errors,
    warnings,
    safeNextAction: errors.length
      ? decision.safeNextAction || EVIDENCE_CONTRACT_SAFE_NEXT_ACTION
      : warnings.length
        ? 'Review residual risks before citing this pipeline outside the bounded local-beta evidence context.'
        : 'Use this pipeline report only inside its local-beta evidence boundary.',
    unsupportedClaims,
  }
}

export function sanitizeEvidenceRefs(refs: Array<string | undefined | null>): string[] {
  return refs
    .map(ref => sanitizeEvidenceRef(ref))
    .filter((ref): ref is string => Boolean(ref))
}

export function sanitizeEvidenceRef(ref: string | undefined | null): string | undefined {
  const text = String(ref || '').trim()
  if (!text) return undefined
  if (containsUnsafeEvidenceText(text) || !isWellFormedEvidenceRef(text)) return `<redacted:ref:${hashText(text)}>`
  return text.length > 180 ? `${text.slice(0, 177)}...` : text
}

export function normalizeEvidenceRefs(refs: string[]): EvidenceContractRef[] {
  return refs.map(ref => {
    const safeRef = String(ref || '').trim()
    return {
      ref: safeRef,
      kind: refKind(safeRef),
      redacted: REDACTED_REF_PATTERN.test(safeRef),
    }
  })
}

export function isWellFormedEvidenceRef(ref: string): boolean {
  const text = String(ref || '').trim()
  if (!text) return false
  if (containsUnsafeEvidenceText(text)) return false
  if (REDACTED_REF_PATTERN.test(text)) return true
  if (DOC_REF_PATTERN.test(text)) return true
  return TYPED_REF_PATTERN.test(text) && !/^https?:\/\//i.test(text)
}

function unsupportedPublicClaim(value: string): boolean {
  return UNSUPPORTED_PUBLIC_CLAIM_PATTERN.test(value)
}

function containsUnsafeEvidenceText(value: string): boolean {
  return SECRET_PATTERN.test(value) || hasRawChannelTarget(value) || PRIVATE_TEXT_PATTERN.test(value) || PRIVATE_PATH_PATTERN.test(value)
}

function hasRawChannelTarget(value: string): boolean {
  const text = String(value || '')
  if (!RAW_CHANNEL_ID_PATTERN.test(text)) return false
  if (/^(session|task|run|event|trace|artifact|roadmap|alert|attention):[A-Za-z0-9_.:-]+$/i.test(text)) return false
  return true
}

function refKind(ref: string): string {
  if (REDACTED_REF_PATTERN.test(ref)) return 'redacted'
  if (DOC_REF_PATTERN.test(ref)) return 'document'
  const index = ref.indexOf(':')
  return index > 0 ? ref.slice(0, index) : 'unknown'
}

function safeFailureRef(ref: string): string {
  return `<redacted:ref:${hashText(ref)}>`
}

function buildProofContract(input: EvidenceContractInput, defaultEvidenceRefs: EvidenceContractRef[], fallbackSafeNextAction: string = EVIDENCE_PROOF_SAFE_NEXT_ACTION): EvidenceProofContract {
  const proofInput = input.proof
  const proofRefs = proofInput?.evidenceRefs
    ? normalizeEvidenceRefs(proofInput.evidenceRefs)
    : defaultEvidenceRefs
  return {
    state: proofInput?.state || defaultProofState(input),
    mode: proofInput?.mode || defaultProofMode(input),
    summary: proofInput?.summary || input.claim.publicClaim,
    safeNextAction: proofInput?.safeNextAction || fallbackSafeNextAction,
    evidenceRefs: proofRefs,
  }
}

function defaultProofState(input: EvidenceContractInput): EvidenceProofState {
  if (input.redaction.state === 'blocked' || !input.redaction.safeToShare) return 'blocked'
  if (input.claim.state === 'release_review_blocked') return 'blocked'
  if (input.claim.effect === 'decision_record_only') return 'supported_bounded'
  return 'supported_bounded'
}

function defaultProofMode(input: EvidenceContractInput): EvidenceProofMode {
  if (input.claim.effect === 'decision_record_only') return 'decision_record'
  return 'local_state'
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

function buildPipelineDecision(input: EvidencePipelineV2DecisionInput | undefined, contracts: EvidenceContractEnvelope[], generatedAt: string): EvidencePipelineV2Decision {
  const safeRefs = sanitizeEvidenceRefs(input?.evidenceRefs || [`pipeline:${timestampId(generatedAt)}`])
  return {
    state: input?.state || 'no_decision',
    claimChange: input?.claimChange || 'no_release_claim_expansion',
    claimEffect: input?.claimEffect || contracts[0]?.claim.effect || 'no_release_claim_expansion',
    summary: input?.summary || 'No release-claim expansion decision is requested by this evidence pipeline.',
    safeNextAction: input?.safeNextAction || 'Keep release wording inside the current local-beta evidence boundary.',
    evidenceRefs: normalizeEvidenceRefs(safeRefs),
  }
}

function countBy(values: string[]): Record<string, number> {
  return values.filter(Boolean).reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] || 0) + 1
    return counts
  }, {})
}

function pipelineSummary(status: EvidencePipelineV2Status, surface: EvidencePipelineV2Surface, counts: EvidencePipelineV2Report['counts'], decision: EvidencePipelineV2Decision): string {
  const base = `${surface} pipeline checked ${counts.evidenceRefs} evidence ref(s), ${counts.failures} validation failure(s), and ${counts.unsupportedClaims} unsupported claim guardrail(s)`
  if (status === 'fail') return `${base}; ${decision.claimChange} is not safe under the current gates.`
  if (status === 'warn') return `${base}; residual risks need review before broader citation.`
  return `${base}; ${decision.claimChange} stays inside the local-beta boundary.`
}

function timestampId(value: string): string {
  return value.replace(/[^0-9]/g, '').slice(0, 14) || 'unknown'
}

function hashText(value: string): string {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12)
}
