import type { AutomationFailureCode } from '@open-cowork/shared'

export type AutomationFailureDisposition = {
  code: AutomationFailureCode | null
  retryable: boolean
  reason: string
}

const EXACT_FAILURE_DISPOSITIONS: Record<AutomationFailureCode, Omit<AutomationFailureDisposition, 'code'>> = {
  brief_unparseable: {
    retryable: false,
    reason: 'The automation output was not parseable and needs prompt or task changes.',
  },
  project_directory_required: {
    retryable: false,
    reason: 'The automation configuration is incomplete and needs a valid project directory.',
  },
  auth_required: {
    retryable: false,
    reason: 'The automation is missing credentials or auth and needs user action.',
  },
  configuration_invalid: {
    retryable: false,
    reason: 'The automation configuration references something unavailable and needs review.',
  },
  runtime_unavailable: {
    retryable: true,
    reason: 'The runtime was temporarily unavailable.',
  },
  daily_run_cap_reached: {
    retryable: false,
    reason: 'The automation has already used its allowed work-run attempts for this day.',
  },
  run_timeout: {
    retryable: true,
    reason: 'The automation exceeded its configured run duration and may succeed on retry.',
  },
  provider_capacity: {
    retryable: true,
    reason: 'The provider returned a transient capacity error.',
  },
  network_transient: {
    retryable: true,
    reason: 'The failure looks network-related and may succeed on retry.',
  },
}

const DETERMINISTIC_FAILURE_PATTERNS: Array<{ pattern: RegExp, code: AutomationFailureCode }> = [
  {
    pattern: /parseable execution brief|did not return a parseable/i,
    code: 'brief_unparseable',
  },
  {
    pattern: /scoped execution automations require a project directory|project directory/i,
    code: 'project_directory_required',
  },
  {
    pattern: /missing api key|missing credentials?|credential|unauthorized|forbidden|invalid api key|invalid token|not signed in|oauth/i,
    code: 'auth_required',
  },
  {
    pattern: /not found|unknown agent|unknown skill|invalid configuration|validation failed/i,
    code: 'configuration_invalid',
  },
  {
    pattern: /daily work-run attempt cap reached|daily work-run cap reached/i,
    code: 'daily_run_cap_reached',
  },
]

const RETRYABLE_FAILURE_PATTERNS: Array<{ pattern: RegExp, code: AutomationFailureCode }> = [
  {
    pattern: /rate limit|429|temporarily unavailable|try again later/i,
    code: 'provider_capacity',
  },
  {
    pattern: /timeout|timed out|fetch failed|econn|enotfound|eai_again|socket hang up|network/i,
    code: 'network_transient',
  },
  {
    pattern: /runtime not started|runtime unavailable|service unavailable/i,
    code: 'runtime_unavailable',
  },
]

export const AUTOMATION_CONSECUTIVE_FAILURE_LIMIT = 3

function resolveExactFailure(code: AutomationFailureCode): AutomationFailureDisposition {
  return {
    code,
    ...EXACT_FAILURE_DISPOSITIONS[code],
  }
}

export function classifyAutomationFailure(
  input: string | { code?: AutomationFailureCode | null, message: string },
): AutomationFailureDisposition {
  const explicitCode = typeof input === 'string' ? null : input.code || null
  const normalized = (typeof input === 'string' ? input : input.message).trim()

  if (explicitCode) {
    return resolveExactFailure(explicitCode)
  }

  for (const entry of DETERMINISTIC_FAILURE_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      return resolveExactFailure(entry.code)
    }
  }

  for (const entry of RETRYABLE_FAILURE_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      return resolveExactFailure(entry.code)
    }
  }

  return {
    code: null,
    retryable: true,
    reason: 'The failure does not match a known deterministic category, so retry remains allowed.',
  }
}
