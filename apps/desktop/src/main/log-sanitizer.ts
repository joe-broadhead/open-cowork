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

// Home-directory-prefixed paths leak usernames and project-folder
// layouts into exported diagnostics bundles. Sanitizing every log
// line would make logs noisier during local debugging, so the
// diagnostics export calls `sanitizeForExport` explicitly — log
// files on disk stay readable for the developer who owns them.
// Match the full home-rooted path up to the next whitespace / quote
// / colon. Replacement keeps the top-level marker so readers still
// know which platform generated the log, but strips the username AND
// every folder below it (project names can be commercially sensitive
// too — "acme-private" reveals more than an attacker should learn
// from a casual-share bug report).
const HOME_PATH_PATTERNS = [
  /\/Users\/[^\s"'`:]+/g,              // macOS
  /\/home\/[^\s"'`:]+/g,               // Linux
  /[A-Z]:\\Users\\[^\s"'`:]+/gi,       // Windows (future-proofing)
]

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

// Stronger sanitizer for content leaving the machine — strips
// home-directory paths on top of the secret patterns. Used by the
// diagnostics bundle export so users can share bundles in a GitHub
// issue without leaking `/Users/alice/work/acme-private` style
// context. On-disk logs bypass this; only the exported copy is
// scrubbed.
export function sanitizeForExport(message: string) {
  let sanitized = sanitizeLogMessage(message)
  for (const pattern of HOME_PATH_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      // Keep the top-level marker so readers still see "this was a
      // macOS path" — just redact the username and the rest.
      const prefix = match.match(/^(\/Users|\/home|[A-Z]:\\Users)/i)?.[0] || '[HOME]'
      return `${prefix}/[REDACTED_HOME]`
    })
  }
  return sanitized
}

export function shortSessionId(sessionId?: string | null) {
  if (!sessionId) return 'unknown'
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8)
}
