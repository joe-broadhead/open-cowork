const fallbackCountersBySessionAndKind = new Map<string, number>()

export function nextSessionScopedFallbackId(sessionId: string, kind: string) {
  const key = `${sessionId}:${kind}`
  const next = (fallbackCountersBySessionAndKind.get(key) || 0) + 1
  fallbackCountersBySessionAndKind.set(key, next)
  return `${sessionId}:${kind}:fallback:${next}`
}

export function resetSessionScopedFallbackIdsForTests() {
  fallbackCountersBySessionAndKind.clear()
}
