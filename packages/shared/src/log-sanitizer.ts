const SECRET_ENV_KEYS = [
  'DATABRICKS_TOKEN',
  'GOOGLE_WORKSPACE_CLI_TOKEN',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_SERVER_PASSWORD',
]

const TOKEN_PATTERNS = [
  // Google OAuth access tokens.
  /\bya29\.[0-9A-Za-z._-]+\b/g,
  // Google API keys (Gemini / Maps / etc. BYOK).
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Slack bot/user/app/refresh tokens (xoxb-/xoxp-/xoxa-/xoxr-/xoxs-).
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Generic JWT (any issuer — Google refresh, Azure, Auth0, etc.).
  /\beyJ[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g,
  // Generic Authorization headers users may paste from curl examples,
  // including the managed OpenCode server's Basic auth header.
  /\bAuthorization:\s*Bearer\s+\S+/gi,
  /\bAuthorization:\s*Basic\s+\S+/gi,
  // GitHub classic personal access tokens (`ghp_`) + fine-grained (`ghu_`,
  // `ghs_`, `ghr_`, `gho_`) and the newer `github_pat_` format.
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // OpenRouter uses `sk-or-<v1|v2|…>-<opaque>`; also catches `sk-or-…` with
  // no version prefix.
  /\bsk-or(?:-[a-z0-9]+)?-[A-Za-z0-9]{20,}\b/g,
  // Anthropic API keys (direct, not via OpenRouter).
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // OpenAI and compatible vendors (Azure OpenAI, Together, etc.). Keep this
  // intentionally broad so `sk-proj-*`, `sk-admin-*`, service-account-style,
  // and future hyphenated key families redact before provider docs catch up.
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  // Databricks personal access tokens — `dapi` prefix followed by a
  // 32-char hex string.
  /\bdapi[0-9a-f]{32}\b/g,
  // Hugging Face tokens are `hf_` plus an opaque blob.
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  // Open Cowork service/gateway tokens and Telegram bot tokens.
  /\boc(?:c|gw)_[A-Za-z0-9_-]{20,}\b/g,
  /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g,
  // Google OAuth client secrets.
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Azure Storage connection strings include a long AccountKey value.
  /\bDefaultEndpointsProtocol=https?;AccountName=[^;\s]+;AccountKey=[^;\s]+(?:;EndpointSuffix=[^;\s]+)?\b/gi,
]

const STRUCTURED_AUTH_VALUE_PATTERN = /\b(["']?authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^"',\s}]{1,4096}/gi
const STRUCTURED_SIGNATURE_VALUE_PATTERN = /\b(["']?(?:x-open-cowork-signature|x-open-cowork-gateway-webhook-signature|x-slack-signature|stripe-signature|signature)["']?\s*[:=]\s*["']?)(?:sha\d+=|v\d+=|t=)?[^"'\s}]{8,4096}/gi

// Every quantifier is bounded to its RFC ceiling (local ≤64, label ≤63, ≤16 labels,
// TLD ≤24) so the match is strictly linear. Any open-ended `+`/`*` here (local part,
// domain labels, or the TLD tail) backtracks quadratically on adversarial input with no
// valid boundary — the source of the prior ReDoS, which de-ambiguation alone didn't fix.
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]{1,64}@(?:[A-Z0-9-]{1,63}\.){1,16}[A-Z]{2,24}\b/gi
// Bound the key-name runs around the keyword to a constant so a long keyword-dense
// string with no `=`/`:` value can't force quadratic backtracking on the leading/trailing
// `*` (ReDoS). Real key names are far shorter than 64 chars.
const KEYED_SECRET_PATTERN = /\b([A-Za-z0-9_-]{0,64}(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|token|secret|password|client[_-]?secret)[A-Za-z0-9_-]{0,64})\s*[:=]\s*(['"]?)[A-Za-z0-9+/=_-]{32,}\2/gi
// Hard ceiling on input length before any pattern runs. The patterns above are now
// linear, so this is defense-in-depth against pathological multi-MB inputs blocking the
// event loop; far above any real log line / error message / diagnostics field.
const MAX_SANITIZE_INPUT_LENGTH = 256 * 1024
const SECRET_REF_PATTERN = /\b(?:gcp-sm|aws-sm|azure-kv):\/\/[^\s"'<>]+/gi
const AZURE_VAULT_SECRET_URL_PATTERN = /\bhttps:\/\/[A-Za-z0-9.-]+\.vault\.azure\.net\/secrets\/[^\s"'<>]+/gi
const SECRET_ENVELOPE_PATTERN = /\b(?:enc|plain):v1:[A-Za-z0-9_-]+\b/g
const SIGNED_URL_QUERY_PATTERN = /\b(https?:\/\/[^\s"'<>?]+)\?[^"'<> \t\r\n]+/gi

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

// Read process.env defensively so this module stays platform-agnostic in the
// shared package. It runs in the Electron main process and the cloud server
// (both Node, where this is exactly `process.env`); anywhere `process` is
// absent it simply skips env-value redaction rather than throwing.
function secretEnvValue(key: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[key]
}

export function sanitizeLogMessage(message: string) {
  let sanitized = message.length > MAX_SANITIZE_INPUT_LENGTH
    ? `${message.slice(0, MAX_SANITIZE_INPUT_LENGTH)}…[truncated]`
    : message

  for (const key of SECRET_ENV_KEYS) {
    const value = secretEnvValue(key)
    if (value) {
      sanitized = sanitized.replace(new RegExp(escapeRegExp(value), 'g'), '[REDACTED_SECRET]')
    }
  }

  sanitized = sanitized.replace(STRUCTURED_AUTH_VALUE_PATTERN, '$1[REDACTED_TOKEN]')
  sanitized = sanitized.replace(STRUCTURED_SIGNATURE_VALUE_PATTERN, '$1[REDACTED_SIGNATURE]')

  for (const pattern of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED_TOKEN]')
  }
  sanitized = sanitized.replace(KEYED_SECRET_PATTERN, (_match, key: string) => `${key}=[REDACTED_TOKEN]`)
  sanitized = sanitized.replace(SECRET_ENVELOPE_PATTERN, '[REDACTED_SECRET]')
  sanitized = sanitized.replace(SECRET_REF_PATTERN, '[REDACTED_SECRET_REF]')
  sanitized = sanitized.replace(AZURE_VAULT_SECRET_URL_PATTERN, '[REDACTED_SECRET_REF]')
  sanitized = sanitized.replace(SIGNED_URL_QUERY_PATTERN, '$1?[REDACTED_QUERY]')

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
