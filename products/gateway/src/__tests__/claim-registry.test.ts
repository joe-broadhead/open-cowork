import { describe, expect, it } from 'vitest'
import {
  buildClaimRegistryReport,
  CLAIM_BOUNDARY,
  formatClaimRegistryReport,
  OVERCLAIM_PATTERN,
  REQUIRED_CLAIM_IDS,
  scanForOverclaims,
} from '../claim-registry.js'

describe('claim registry', () => {
  it('passes with the shipped claim boundary', () => {
    const report = buildClaimRegistryReport({ generatedAt: '2026-07-04T00:00:00.000Z' })
    expect(report.status).toBe('pass')
    expect(report.issues).toEqual([])
    expect(report.claims.length).toBe(CLAIM_BOUNDARY.length)
    expect(report.blockedWording.length).toBeGreaterThan(0)
  })

  it('keeps every release-critical claim id present', () => {
    const ids = new Set(CLAIM_BOUNDARY.map(claim => claim.id))
    for (const required of REQUIRED_CLAIM_IDS) {
      expect(ids.has(required), `missing release-critical claim ${required}`).toBe(true)
    }
  })

  it('fails when a release-critical claim is dropped', () => {
    const withoutProduction = CLAIM_BOUNDARY.filter(claim => claim.id !== 'production')
    const report = buildClaimRegistryReport({ claims: withoutProduction })
    expect(report.status).toBe('fail')
    expect(report.issues.some(issue => issue.code === 'missing_claim:production')).toBe(true)
  })

  it('fails when no blocked claims remain', () => {
    const allAllowed = CLAIM_BOUNDARY.map(claim => ({ ...claim, state: 'allowed' as const }))
    const report = buildClaimRegistryReport({ claims: allAllowed })
    expect(report.issues.some(issue => issue.code === 'no_blocked_claims')).toBe(true)
  })

  it('fails when allowed wording overclaims', () => {
    const claims = CLAIM_BOUNDARY.map(claim =>
      claim.id === 'public_local_beta'
        ? { ...claim, allowedWording: 'Gateway is production ready for everyone.' }
        : claim,
    )
    const report = buildClaimRegistryReport({ claims })
    expect(report.issues.some(issue => issue.code.startsWith('overclaim_in_allowed_wording'))).toBe(true)
  })

  it('scans copy for overclaims and exempts boundary statements', () => {
    const text = [
      'OpenCode Gateway is a local durable work coordinator.',
      'It is production ready and battle tested.',
      'Note: production certification remains blocked until the evidence exists.',
      'Multi-tenant ready deployments are coming eventually.',
    ].join('\n')
    const findings = scanForOverclaims('README.md', text)
    expect(findings.map(finding => finding.line)).toEqual([2, 4])
    expect(findings[0]!.match.toLowerCase()).toContain('production ready')
  })

  it('the overclaim pattern still catches the historical claim classes', () => {
    for (const phrase of [
      'production ready',
      'hosted/team ready',
      'SaaS ready',
      'multi-tenant ready',
      'universal-channel ready',
      'arbitrary scale',
      'unattended operation supported',
      'formal compliance certified',
    ]) {
      expect(OVERCLAIM_PATTERN.test(phrase), `pattern must catch: ${phrase}`).toBe(true)
    }
  })

  it('formats a readable report', () => {
    const report = buildClaimRegistryReport({ generatedAt: '2026-07-04T00:00:00.000Z' })
    const text = formatClaimRegistryReport(report)
    expect(text).toContain('Claim registry — PASS')
    expect(text).toContain('[BLOCKED ] production')
    expect(text).toContain('public local beta for one trusted local operator')
  })
})
