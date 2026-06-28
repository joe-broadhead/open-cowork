import type { PrimaryAgentMode } from '../stores/session.ts'
import { t } from './i18n.ts'

export const PRIMARY_AGENT_MODES = ['build', 'plan', 'chief-of-staff'] as const satisfies readonly PrimaryAgentMode[]

const PRIMARY_AGENT_MODE_SET = new Set<string>(PRIMARY_AGENT_MODES)

export function isPrimaryAgentMode(value: string): value is PrimaryAgentMode {
  return PRIMARY_AGENT_MODE_SET.has(value)
}

export function nextPrimaryAgentMode(mode: PrimaryAgentMode): PrimaryAgentMode {
  if (mode === 'build') return 'plan'
  if (mode === 'plan') return 'chief-of-staff'
  return 'build'
}

export function primaryAgentModeLabel(mode: PrimaryAgentMode) {
  if (mode === 'plan') return t('chat.planMode', 'Plan')
  if (mode === 'chief-of-staff') return t('chat.cleoMode', 'Cleo')
  return t('chat.buildMode', 'Build')
}

export function primaryAgentLeadLabel(mode: PrimaryAgentMode) {
  if (mode === 'plan') return t('home.coworkers.planning', 'Plan lead')
  if (mode === 'chief-of-staff') return t('home.coworkers.cleoLead', 'Cleo lead')
  return t('home.coworkers.building', 'Build lead')
}
