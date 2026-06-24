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

function splitReplacementTextFromRightByPreviousLengths(
  segments: readonly { content: string }[],
  replacement: string,
) {
  const result = new Array<string>(segments.length).fill('')
  let offset = replacement.length
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const segmentLength = segments[index]?.content.length ?? 0
    const nextOffset = Math.max(0, offset - segmentLength)
    result[index] = replacement.slice(nextOffset, offset)
    offset = nextOffset
  }
  result[0] = replacement.slice(0, offset)
  return result
}

export function splitReplacementTextByPreviousSegments(
  segments: readonly { content: string }[],
  replacement: string,
) {
  if (segments.length <= 1) return [replacement]

  const prefixContent = segments
    .slice(0, -1)
    .map((segment) => segment.content)
    .join('')
  if (replacement.startsWith(prefixContent)) {
    return [
      ...segments.slice(0, -1).map((segment) => segment.content),
      replacement.slice(prefixContent.length),
    ]
  }

  const boundaries = new Array<number>(segments.length + 1)
  boundaries[0] = 0
  boundaries[segments.length] = replacement.length
  let searchBefore = replacement.length

  // Anchor later segments from the right so edits that shorten earlier text
  // don't pull post-tool text back before the tool boundary.
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const content = segments[index]?.content || ''
    if (!content) {
      boundaries[index] = searchBefore
      continue
    }

    const match = replacement.lastIndexOf(content, searchBefore - content.length)
    if (match < 0) {
      return splitReplacementTextFromRightByPreviousLengths(segments, replacement)
    }

    boundaries[index] = match
    searchBefore = match
  }

  return segments.map((_segment, index) => (
    replacement.slice(boundaries[index], boundaries[index + 1])
  ))
}
