export interface TokenSnapshot {
  access_token?: string | null
  expiry_date?: number | null
}

const TOKEN_EXPIRY_SKEW_MS = 60_000

export function getUsableAccessToken(
  tokens: TokenSnapshot | null | undefined,
  now = Date.now(),
) {
  if (!tokens?.access_token) return null
  if (!tokens.expiry_date) return tokens.access_token
  return now < tokens.expiry_date - TOKEN_EXPIRY_SKEW_MS
    ? tokens.access_token
    : null
}
