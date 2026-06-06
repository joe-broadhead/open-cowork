export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

export function nextEnabledIndex<T extends { disabled?: boolean }>(
  items: T[],
  current: number,
  direction: 1 | -1,
) {
  if (items.length === 0) return -1
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (current + (offset * direction) + items.length) % items.length
    if (!items[index]?.disabled) return index
  }
  return -1
}
