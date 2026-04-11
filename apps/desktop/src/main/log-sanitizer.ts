const SECRET_ENV_KEYS = [
  'DATABRICKS_TOKEN',
  'GOOGLE_WORKSPACE_CLI_TOKEN',
]

const TOKEN_PATTERNS = [
  /\bya29\.[0-9A-Za-z._-]+\b/g,
  /\beyJ[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
]

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function sanitizeLogMessage(message: string) {
  let sanitized = message

  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key]
    if (value) {
      sanitized = sanitized.replace(new RegExp(escapeRegExp(value), 'g'), '[REDACTED_SECRET]')
    }
  }

  for (const pattern of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED_TOKEN]')
  }

  sanitized = sanitized.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
  return sanitized
}

export function shortSessionId(sessionId?: string | null) {
  if (!sessionId) return 'unknown'
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8)
}
