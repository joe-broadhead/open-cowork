// Identity colour for non-agent entities (tools, skills, channels, spaces,
// artifacts, playbooks…). Agents get a chosen colour via agentChroma; everything
// else gets a DETERMINISTIC hue from its name/id, so each list reads as a stable,
// colourful "gallery" (the agents-page vibe) without anyone hand-assigning colours.
//
// The palette is the same identity family the avatars use (one surgical accent
// plus a spread of confident hues), so the whole app shares one colour language.
const ENTITY_HUES = [
  'var(--color-accent)', // periwinkle
  '#7c6fd6', // violet
  'var(--color-info)', // cyan
  'var(--color-green)', // teal/green
  'var(--color-amber)', // gold
  '#e8729e', // rose
  '#5aa9ff', // azure
  '#5ec8b0', // mint
] as const

export function entityChroma(seed: string | null | undefined): string {
  const value = String(seed || 'entity')
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return ENTITY_HUES[hash % ENTITY_HUES.length] ?? ENTITY_HUES[0]
}
