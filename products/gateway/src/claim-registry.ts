/**
 * Claim registry: the single source of truth for what OpenCode Gateway may
 * and may not claim publicly.
 *
 * This replaces the M27–M59 milestone report modules. Their durable value —
 * a machine-checked boundary between allowed, blocked, and deferred release
 * claims, plus an overclaim scanner that keeps README/docs/CLI copy honest —
 * lives here as one data table and a small engine. The narrative history of
 * how each boundary was decided lives in docs/history/decision-log.md.
 *
 * Rules enforced by `buildClaimRegistryReport` (and tested in
 * src/__tests__/claim-registry.test.ts):
 *   - every claim id is unique and carries explicit wording for its state;
 *   - every blocked/deferred claim contributes required blocked wording;
 *   - no allowed wording matches the overclaim pattern;
 *   - the registry always contains the release-critical claim ids, so a
 *     refactor can never silently drop a boundary.
 */

export type ClaimState = 'allowed' | 'blocked' | 'deferred'

export interface ClaimRecord {
  /** Stable id; release tooling and docs reference these. */
  id: string
  state: ClaimState
  /** What we may say today. */
  allowedWording: string
  /** The wording that must appear wherever this boundary is discussed. */
  blockedWording: string
  /** The next concrete step that could move this boundary. */
  safeNextAction: string
}

export interface ClaimRegistryReport {
  generatedAt: string
  decision: string
  claims: ClaimRecord[]
  blockedWording: string[]
  issues: Array<{ code: string; summary: string }>
  status: 'pass' | 'fail'
}

/**
 * Release-critical claim ids. `buildClaimRegistryReport` fails if any of
 * these is missing from the registry, whatever else changes.
 */
export const REQUIRED_CLAIM_IDS = [
  'public_local_beta',
  'public_release_candidate',
  'production',
  'hosted_team_saas_multi_tenant',
  'universal_channel_provider_live',
  'arbitrary_scale_unattended',
  'managed_support_compliance',
] as const

/**
 * Wording that would overclaim the current boundary anywhere in public copy.
 * scripts/check-release.mjs applies this to README, docs, and CLI help by
 * calling `scanForOverclaims` from the built dist/claim-registry.js.
 */
export const OVERCLAIM_PATTERN =
  /\b(?:public beta approved|public-beta ready|public release-candidate approved|release-candidate ready|production ready|production certified|hosted\/team ready|SaaS ready|multi-tenant ready|universal-channel ready|provider parity certified|WhatsApp live parity certified|arbitrary scale|unattended operation supported|managed support ready|formal compliance certified)\b/i

/** The current, deliberate decision for the product's release posture. */
export const CURRENT_DECISION =
  'OpenCode Gateway is a public local beta for one trusted local operator. Broader claims stay blocked until their evidence exists.'

export const CLAIM_BOUNDARY: readonly ClaimRecord[] = [
  {
    id: 'public_local_beta',
    state: 'allowed',
    allowedWording:
      'Gateway may be described as a public local beta for one trusted local operator on previously validated local surfaces (local Web, TUI, Telegram, local daemon, and evidence surfaces).',
    blockedWording:
      'Current local-beta wording does not approve broader public-beta readiness or release-candidate wording.',
    safeNextAction:
      'Keep current-beta copy tied to the validated local surfaces; expand only with fresh evidence.',
  },
  {
    id: 'public_release_candidate',
    state: 'blocked',
    allowedWording: 'No public release-candidate wording is approved.',
    blockedWording: 'public release-candidate approval remains blocked',
    safeNextAction:
      'Complete the production-hardening tranche (auth beyond localhost, backend parity, elapsed soak) and record a fresh decision.',
  },
  {
    id: 'production',
    state: 'blocked',
    allowedWording: 'No production wording is approved.',
    blockedWording: 'production certification remains blocked',
    safeNextAction:
      'Run production readiness evidence (soak, recovery drills under load, security review) before changing production wording.',
  },
  {
    id: 'hosted_team_saas_multi_tenant',
    state: 'blocked',
    allowedWording: 'No hosted/team, SaaS, or multi-tenant wording is approved.',
    blockedWording: 'hosted/team, SaaS, and multi-tenant readiness remain blocked',
    safeNextAction:
      'Land tenancy, hosted control plane, team auth, and support custody with their own evidence before tenancy wording.',
  },
  {
    id: 'universal_channel_provider_live',
    state: 'deferred',
    allowedWording:
      'Telegram is the proven live channel. WhatsApp and Discord ship as deterministic adapters without live-parity claims.',
    blockedWording: 'universal-channel readiness remains blocked',
    safeNextAction:
      'Require provider-specific live proof (or an explicit recorded waiver) before any channel-parity wording.',
  },
  {
    id: 'arbitrary_scale_unattended',
    state: 'blocked',
    allowedWording:
      'Fleet limits, budgets, and kill switches are proven at configured local limits only.',
    blockedWording: 'arbitrary scale remains blocked; unattended operation remains blocked',
    safeNextAction:
      'Prove sustained scale and human-handoff behavior on real workloads before scale or unattended wording.',
  },
  {
    id: 'managed_support_compliance',
    state: 'blocked',
    allowedWording:
      'Support means redacted incident bundles and operator handoff docs, not staffed support.',
    blockedWording:
      'managed support readiness remains blocked; formal compliance certification remains blocked',
    safeNextAction:
      'Route staffed support, retention, legal/privacy, and compliance assessment through their own future tranche.',
  },
]

export function buildClaimRegistryReport(options: { generatedAt?: string; claims?: readonly ClaimRecord[] } = {}): ClaimRegistryReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const claims = (options.claims ?? CLAIM_BOUNDARY).map(claim => ({ ...claim }))
  const issues: ClaimRegistryReport['issues'] = []

  const seen = new Set<string>()
  for (const claim of claims) {
    if (seen.has(claim.id)) issues.push({ code: `duplicate_claim:${claim.id}`, summary: `Claim id ${claim.id} appears more than once.` })
    seen.add(claim.id)
    if (!claim.allowedWording.trim() || !claim.blockedWording.trim() || !claim.safeNextAction.trim()) {
      issues.push({ code: `incomplete_claim:${claim.id}`, summary: `Claim ${claim.id} is missing wording or a safe next action.` })
    }
    if (OVERCLAIM_PATTERN.test(claim.allowedWording)) {
      issues.push({ code: `overclaim_in_allowed_wording:${claim.id}`, summary: `Allowed wording for ${claim.id} matches the overclaim pattern.` })
    }
  }
  for (const required of REQUIRED_CLAIM_IDS) {
    if (!seen.has(required)) issues.push({ code: `missing_claim:${required}`, summary: `Release-critical claim ${required} is missing from the registry.` })
  }
  if (!claims.some(claim => claim.state === 'blocked')) {
    issues.push({ code: 'no_blocked_claims', summary: 'The registry must keep explicit blocked claims until their evidence exists.' })
  }

  const blockedWording = claims
    .filter(claim => claim.state !== 'allowed')
    .map(claim => claim.blockedWording)

  return {
    generatedAt,
    decision: CURRENT_DECISION,
    claims,
    blockedWording,
    issues,
    status: issues.length === 0 ? 'pass' : 'fail',
  }
}

export interface OverclaimFinding {
  source: string
  line: number
  match: string
  excerpt: string
}

/**
 * Scan public copy (README, docs pages, CLI help) for wording that exceeds
 * the current claim boundary. Lines that quote a blocked wording verbatim
 * (i.e. state the boundary) are exempt.
 */
export function scanForOverclaims(source: string, text: string): OverclaimFinding[] {
  const findings: OverclaimFinding[] = []
  const blocked = CLAIM_BOUNDARY.filter(claim => claim.state !== 'allowed').map(claim => claim.blockedWording.toLowerCase())
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const match = OVERCLAIM_PATTERN.exec(line)
    if (!match) continue
    const lower = line.toLowerCase()
    if (blocked.some(wording => lower.includes(wording))) continue
    if (/remains? blocked|not (?:yet )?approved|blocked until|stays? blocked|is not|are not|no .* wording|do not|does not (?:prove|claim|imply|constitute|establish|mean|assert)|without/i.test(line)) continue
    findings.push({ source, line: index + 1, match: match[0]!, excerpt: line.trim().slice(0, 160) })
  }
  return findings
}

export function formatClaimRegistryReport(report: ClaimRegistryReport): string {
  const lines: string[] = []
  lines.push(`Claim registry — ${report.status.toUpperCase()} (${report.generatedAt})`)
  lines.push(report.decision)
  lines.push('')
  for (const claim of report.claims) {
    lines.push(`[${claim.state.toUpperCase().padEnd(8)}] ${claim.id}`)
    lines.push(`  allowed: ${claim.allowedWording}`)
    if (claim.state !== 'allowed') lines.push(`  blocked: ${claim.blockedWording}`)
    lines.push(`  next:    ${claim.safeNextAction}`)
  }
  if (report.issues.length > 0) {
    lines.push('')
    lines.push('Issues:')
    for (const issue of report.issues) lines.push(`  - ${issue.code}: ${issue.summary}`)
  }
  return lines.join('\n')
}
