import test from 'node:test'
import assert from 'node:assert/strict'
import { KNOWLEDGE_SPACE_HUES, knowledgeSpaceHue } from '../packages/ui/src/knowledge-hues.ts'

test('knowledgeSpaceHue cycles the palette by index and reserves the accent for the root', () => {
  // Each Space index maps to its palette entry so the Spaces-rail tile and the
  // graph node for the same Space tint identically.
  KNOWLEDGE_SPACE_HUES.forEach((hue, index) => {
    assert.equal(knowledgeSpaceHue(index), hue)
  })
  // The palette wraps for more Spaces than colours.
  assert.equal(knowledgeSpaceHue(KNOWLEDGE_SPACE_HUES.length), KNOWLEDGE_SPACE_HUES[0])
  assert.equal(knowledgeSpaceHue(KNOWLEDGE_SPACE_HUES.length + 2), KNOWLEDGE_SPACE_HUES[2])
  // The root node (negative index) uses the theme accent, not a Space hue.
  assert.equal(knowledgeSpaceHue(-1), 'var(--color-accent)')
})
