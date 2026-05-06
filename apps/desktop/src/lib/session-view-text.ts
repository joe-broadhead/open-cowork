export function mergeStreamingText(existing: string, incoming: string) {
  if (!existing) return incoming
  if (!incoming) return existing
  if (incoming === existing) return existing
  if (incoming.startsWith(existing)) return incoming
  if (existing.endsWith(incoming)) return existing

  const maxOverlap = Math.min(existing.length, incoming.length)
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      return `${existing}${incoming.slice(overlap)}`
    }
  }

  return `${existing}${incoming}`
}

export function preferNewerStreamingText(snapshotContent: string, existingContent: string) {
  if (!existingContent) return snapshotContent
  if (!snapshotContent) return existingContent
  if (snapshotContent === existingContent) return snapshotContent
  if (snapshotContent.startsWith(existingContent)) return snapshotContent
  if (existingContent.startsWith(snapshotContent)) return existingContent
  return existingContent
}
