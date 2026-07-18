import { describe, expect, it } from 'vitest'
import { buildEvidenceContract, buildEvidencePipelineV2, sanitizeEvidenceRefs, summarizeEvidenceContractState } from '../evidence-contract.js'

describe('evidence contract', () => {
  it('builds a versioned pass contract for redacted local-beta evidence', () => {
    const contract = buildEvidenceContract({
      generatedAt: '2026-06-24T18:00:00.000Z',
      claim: {
        state: 'local_beta_evidence_only',
        effect: 'local_evidence_integrity_only',
        publicClaim: 'Redacted local public-beta evidence only.',
        boundary: 'No release-claim expansion from this evidence.',
        unsupportedClaims: ['hosted readiness', 'raw transcript diagnostics'],
      },
      redaction: {
        state: 'redacted',
        safeToShare: true,
        rules: ['mask channel targets', 'mask private paths'],
      },
      evidenceRefs: ['docs/operations/m36-deepen-simplify-public-beta-hardening-scope-gate.md', 'event:event_123', 'task:task_safe'],
      residualRisks: [{
        id: 'live_channel_deferred',
        state: 'deferred',
        summary: 'Live provider proof remains deferred.',
        safeNextAction: 'Run named provider proof before changing provider claims.',
      }],
    })

    expect(contract.schemaVersion).toBe(1)
    expect(contract.claimState).toBe('local_beta_evidence_only')
    expect(contract.proof).toMatchObject({
      state: 'supported_bounded',
      mode: 'local_state',
      summary: 'Redacted local public-beta evidence only.',
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ kind: 'document' })]),
    })
    expect(contract.validation.state).toBe('pass')
    expect(summarizeEvidenceContractState(contract)).toMatchObject({
      claimState: 'local_beta_evidence_only',
      proofState: 'supported_bounded',
      redactionState: 'redacted',
      validationState: 'pass',
      safeToShare: true,
    })
    expect(contract.evidenceRefs.map(ref => ref.kind)).toEqual(['document', 'event', 'task'])
    expect(contract.claim.effect).toBe('local_evidence_integrity_only')
  })

  it('keeps explicit proof-state refs and fails unsafe proof text closed', () => {
    const contract = buildEvidenceContract({
      generatedAt: '2026-06-24T18:00:00.000Z',
      claim: {
        state: 'release_review_blocked',
        effect: 'decision_record_only',
        publicClaim: 'Release review remains blocked.',
        boundary: 'No release-claim expansion from this decision.',
      },
      redaction: {
        state: 'redacted',
        safeToShare: true,
        rules: ['mask provider targets'],
      },
      proof: {
        state: 'blocked',
        mode: 'decision_record',
        summary: 'Blocked until private transcript body is reviewed.',
        safeNextAction: 'Regenerate without private transcript text.',
        evidenceRefs: ['docs/operations/m40-world-class-codebase-release-quality-scope-gate.md'],
      },
    })

    expect(contract.proof.evidenceRefs.map(ref => ref.kind)).toEqual(['document'])
    expect(contract.validation.state).toBe('fail')
    expect(contract.validation.failures.map(failure => failure.code)).toContain('unsafe_or_missing_proof_summary')
  })

  it('fails closed for missing claim state, unsupported wording, unsafe refs, and private text', () => {
    const contract = buildEvidenceContract({
      generatedAt: '2026-06-24T18:00:00.000Z',
      claim: {
        state: undefined as any,
        effect: 'local_evidence_integrity_only',
        publicClaim: 'Gateway is production ready.',
        boundary: 'Gateway is release-candidate ready.',
      },
      redaction: {
        state: 'blocked',
        safeToShare: false,
        rules: [],
        safeNextAction: 'Regenerate a redacted evidence bundle before sharing.',
      },
      proof: {
        state: 'unsafe_state' as any,
        mode: 'unsafe_mode' as any,
        summary: 'private transcript body',
        safeNextAction: 'Share token=operator-secret-token with support.',
        evidenceRefs: ['telegram:123456789012'],
      },
      evidenceRefs: [
        'bad ref with spaces',
        'telegram:123456789012',
        '/Users/joe/private/support.log',
        'event:event_safe',
      ],
      rawTextSamples: [
        'private transcript body token=operator-secret-token',
      ],
      residualRisks: [{
        id: 'unsafe_risk',
        state: 'open',
        summary: 'Inspect /Users/joe/private/support.log',
        safeNextAction: 'Share token=operator-secret-token with support.',
      }],
    })

    expect(contract.validation.state).toBe('fail')
    expect(contract.validation.safeNextAction).toBe('Regenerate a redacted evidence bundle before sharing.')
    expect(contract.validation.failures.map(failure => failure.code)).toEqual(expect.arrayContaining([
      'missing_or_unsupported_claim_state',
      'unsupported_public_wording',
      'unsupported_claim_boundary',
      'missing_redaction_rules',
      'redaction_not_share_safe',
      'missing_or_unsupported_proof_state',
      'missing_or_unsupported_proof_mode',
      'unsafe_or_missing_proof_summary',
      'unsafe_or_missing_proof_next_action',
      'malformed_proof_evidence_ref',
      'malformed_evidence_ref',
      'unsafe_evidence_ref',
      'unsafe_raw_text_sample',
      'unsafe_residual_risk_text',
    ]))
  })

  it('sanitizes unsafe refs while keeping typed and document refs inspectable', () => {
    const refs = sanitizeEvidenceRefs([
      'docs/operations/public-release-certification-joe-200.md',
      'trace:trace_root_abc123',
      'telegram:123456789012',
      'Bearer operator-secret-token',
      '/private/tmp/gateway.db',
      undefined,
    ])

    expect(refs).toHaveLength(5)
    expect(refs[0]).toBe('docs/operations/public-release-certification-joe-200.md')
    expect(refs[1]).toBe('trace:trace_root_abc123')
    expect(refs.slice(2)).toEqual([
      expect.stringMatching(/^<redacted:ref:[a-f0-9]{12}>$/),
      expect.stringMatching(/^<redacted:ref:[a-f0-9]{12}>$/),
      expect.stringMatching(/^<redacted:ref:[a-f0-9]{12}>$/),
    ])
  })

  it('builds the M41 Evidence Pipeline V2 report from existing contracts', () => {
    const contract = buildEvidenceContract({
      generatedAt: '2026-06-25T12:00:00.000Z',
      claim: {
        state: 'local_beta_evidence_only',
        effect: 'local_evidence_integrity_only',
        publicClaim: 'Redacted local public-beta evidence only.',
        boundary: 'No release-claim expansion from this evidence.',
        unsupportedClaims: ['hosted readiness'],
      },
      redaction: {
        state: 'redacted',
        safeToShare: true,
        rules: ['mask channel targets'],
      },
      evidenceRefs: ['trace:trace_root_safe', 'event:event_safe'],
      residualRisks: [{
        id: 'live_provider_deferred',
        state: 'deferred',
        summary: 'Live provider proof remains deferred.',
        safeNextAction: 'Keep provider-live claims blocked until named evidence exists.',
      }],
    })

    const pipeline = buildEvidencePipelineV2({
      surface: 'release_decision',
      contracts: [contract],
      generatedAt: '2026-06-25T12:00:00.000Z',
      decision: {
        state: 'no_decision',
        claimChange: 'no_release_claim_expansion',
        claimEffect: 'decision_record_only',
        summary: 'No release-claim expansion is requested.',
        safeNextAction: 'Keep release wording inside the current local beta boundary.',
        evidenceRefs: ['decision:m41_6'],
      },
    })

    expect(pipeline).toMatchObject({
      schemaVersion: 1,
      mode: 'm41_evidence_pipeline_v2',
      owner: 'evidence-contract',
      surface: 'release_decision',
      status: 'warn',
      releaseClaimBoundary: 'local_beta_evidence_pipeline_only_no_release_claim_expansion',
      contractCount: 1,
      acceptance: {
        ownerDocumented: true,
        contractsPresent: true,
        validationGatePass: true,
        redactionGatePass: true,
        evidenceRefsGatePass: true,
        decisionGatePass: true,
        compatibilityReadable: true,
        noReleaseClaimExpansion: true,
      },
      counts: {
        evidenceRefs: 5,
        unsupportedClaims: 1,
        failures: 0,
      },
      decision: {
        state: 'no_decision',
        claimChange: 'no_release_claim_expansion',
      },
      errors: [],
      warnings: ['residual_risk_deferred'],
    })
  })

  it('fails Evidence Pipeline V2 closed for unsafe release advancement', () => {
    const unsafe = buildEvidenceContract({
      generatedAt: '2026-06-25T12:00:00.000Z',
      claim: {
        state: 'release_review_blocked',
        effect: 'decision_record_only',
        publicClaim: 'Release review remains blocked.',
        boundary: 'No release-claim expansion from this decision.',
        unsupportedClaims: ['production certification'],
      },
      redaction: {
        state: 'blocked',
        safeToShare: false,
        rules: ['mask private content'],
      },
      evidenceRefs: ['telegram:123456789012'],
    })
    const pipeline = buildEvidencePipelineV2({
      surface: 'release_decision',
      contracts: [unsafe],
      decision: {
        state: 'decision_supported',
        claimChange: 'advance_requested',
        claimEffect: 'decision_record_only',
        summary: 'Gateway is production ready.',
        safeNextAction: 'Publish release-candidate wording.',
      },
    })

    expect(pipeline.status).toBe('fail')
    expect(pipeline.acceptance).toMatchObject({
      validationGatePass: false,
      redactionGatePass: false,
      decisionGatePass: false,
      noReleaseClaimExpansion: false,
    })
    expect(pipeline.errors).toEqual(expect.arrayContaining([
      'validation_gate_failed',
      'redaction_gate_failed',
      'decision_gate_failed',
      'unsafe_decision_text',
      'release_claim_advance_has_unsupported_claims',
    ]))
  })
})
