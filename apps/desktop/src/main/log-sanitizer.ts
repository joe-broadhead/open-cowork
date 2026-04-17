const SECRET_ENV_KEYS = [
  'DATABRICKS_TOKEN',
  'GOOGLE_WORKSPACE_CLI_TOKEN',
]

const TOKEN_PATTERNS = [
  // Google OAuth access tokens.
  /\bya29\.[0-9A-Za-z._-]+\b/g,
  // Generic JWT (any issuer — Google refresh, Azure, Auth0, etc.).
  /\beyJ[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g,
  // GitHub classic personal access tokens (`ghp_`) + fine-grained (`ghu_`,
  // `ghs_`, `ghr_`, `gho_`) and the newer `github_pat_` format.
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // OpenRouter uses `sk-or-<v1|v2|…>-<opaque>`; also catches `sk-or-…` with
  // no version prefix.
  /\bsk-or(?:-[a-z0-9]+)?-[A-Za-z0-9]{20,}\b/g,
  // Anthropic API keys (direct, not via OpenRouter).
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // OpenAI and compatible vendors (Azure OpenAI, Together, etc.).
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  // Databricks personal access tokens — `dapi` prefix followed by a
  // 32-char hex string.
  /\bdapi[0-9a-f]{32}\b/g,
  // Hugging Face tokens are `hf_` plus an opaque blob.
  /\bhf_[A-Za-z0-9]{20,}\b/g,
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
