// The muted, harmonious Space hues from the design's coworker palette. Spaces
// cycle through these by index. Single-sourced here so the Knowledge graph nodes
// and the Spaces-rail tiles tint each Space identically across both surfaces.
export const KNOWLEDGE_SPACE_HUES = ['#6f8cc4', '#7e9b6a', '#c79348', '#c46a72', '#9d82c0', '#5fa0a0'] as const

/**
 * Resolve the hue for a Space by its index in the (readable) Space ordering. A
 * negative index (the graph root) returns the theme accent so the root stands
 * apart from the orbiting Spaces.
 */
export function knowledgeSpaceHue(spaceIndex: number): string {
  if (spaceIndex < 0) return 'var(--color-accent)'
  return KNOWLEDGE_SPACE_HUES[spaceIndex % KNOWLEDGE_SPACE_HUES.length] as string
}
