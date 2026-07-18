import { getConfig, type AgentProfile, type GatewayConfig } from './config.js'

export interface ProfileExpectation {
  profile: string
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  requiredSkills: string[]
}

export interface ProfileDrift {
  profile: string
  missing: boolean
  issues: string[]
}

export const GATEWAY_PROFILE_EXPECTATIONS: ProfileExpectation[] = [
  { profile: 'reviewer', agent: 'gateway-reviewer', model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'xhigh' }, requiredSkills: ['gateway-stage', 'gateway-review-gate'] },
  { profile: 'verifier', agent: 'gateway-verifier', model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'xhigh' }, requiredSkills: ['gateway-stage', 'gateway-review-gate'] },
  { profile: 'supervisor', agent: 'gateway-supervisor', model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'xhigh' }, requiredSkills: ['gateway-supervisor'] },
]

export function detectGatewayProfileDrift(config: GatewayConfig = getConfig()): ProfileDrift[] {
  return GATEWAY_PROFILE_EXPECTATIONS.map(expectation => compareProfile(config.profiles[expectation.profile], expectation)).filter(row => row.missing || row.issues.length)
}

export function formatProfileDrift(drift: ProfileDrift[]): string {
  if (!drift.length) return 'Gateway-owned profile defaults are current.'
  return drift.map(row => `${row.profile}: ${row.missing ? 'missing profile' : row.issues.join('; ')}`).join('\n')
}

function compareProfile(profile: AgentProfile | undefined, expectation: ProfileExpectation): ProfileDrift {
  const issues: string[] = []
  if (!profile) return { profile: expectation.profile, missing: true, issues }
  if (profile.agent !== expectation.agent) issues.push(`agent is ${profile.agent}, expected ${expectation.agent}`)
  if (profile.model.providerID !== expectation.model.providerID || profile.model.modelID !== expectation.model.modelID || profile.model.variant !== expectation.model.variant) {
    const actual = `${profile.model.providerID}/${profile.model.modelID}${profile.model.variant ? `:${profile.model.variant}` : ''}`
    const expected = `${expectation.model.providerID}/${expectation.model.modelID}${expectation.model.variant ? `:${expectation.model.variant}` : ''}`
    issues.push(`model is ${actual}, expected ${expected}`)
  }
  const skills = new Set(profile.skills || [])
  const missingSkills = expectation.requiredSkills.filter(skill => !skills.has(skill))
  if (missingSkills.length) issues.push(`missing skills: ${missingSkills.join(', ')}`)
  return { profile: expectation.profile, missing: false, issues }
}
