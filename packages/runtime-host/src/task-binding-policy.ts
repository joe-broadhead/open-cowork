export type BindingHints = {
  title?: string | null
  agent?: string | null
}

// OpenCode owns child-session creation and parent lineage. Cowork may
// bind an arriving child session to a pending task only when there is a
// single possible candidate under that immediate parent. When there are
// multiple candidates, title/agent metadata is treated as display-only:
// matching on it creates a second app-side resolution path and can attach
// the wrong child to the wrong task during concurrent delegation.
export function findOnlyIndexedCandidate<T>(
  entries: T[],
) {
  if (entries.length <= 1) return entries.length === 1 ? 0 : -1
  return -1
}
