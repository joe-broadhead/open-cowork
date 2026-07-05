export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

// Identity colour for non-agent entities (tools, skills, channels, spaces,
// artifacts, playbooks…). Deterministic from the seed so each list reads as a
// stable, colourful "gallery" (the agents-page vibe) with no hand-assigned
// colours. Pair with the `.entity-tile` recipe (sets --entity-chroma to this).
const ENTITY_HUES = [
  'var(--color-accent)',
  '#7c6fd6',
  'var(--color-info)',
  'var(--color-green)',
  'var(--color-amber)',
  '#e8729e',
  '#5aa9ff',
  '#5ec8b0',
] as const

export function entityChroma(seed: string | null | undefined): string {
  const value = String(seed || 'entity')
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return ENTITY_HUES[hash % ENTITY_HUES.length] ?? ENTITY_HUES[0]
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
