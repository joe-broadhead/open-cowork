import test from 'node:test'
import assert from 'node:assert/strict'
import {
  knowledgeDraftToBlocks,
  knowledgePageBlocksToDraft,
  type KnowledgePageBlock,
} from '../packages/shared/src/knowledge.ts'

test('knowledge draft helpers round-trip a page body without losing structure', () => {
  const blocks: KnowledgePageBlock[] = [
    { id: 'h1', type: 'h', text: 'Operating model' },
    { id: 'p1', type: 'p', text: 'A paragraph.' },
    { id: 'c1', type: 'callout', text: 'A callout.' },
    { id: 'l1', type: 'list', items: ['first', 'second'] },
  ]
  const drafts = knowledgePageBlocksToDraft(blocks)
  assert.deepEqual(drafts.map((draft) => draft.type), ['h', 'p', 'callout', 'list'])
  // List items flatten to newline-joined editable text.
  assert.equal(drafts[3]?.text, 'first\nsecond')
  // Round-trips back to the identical structured body.
  assert.deepEqual(knowledgeDraftToBlocks(drafts), blocks)
})

test('knowledge draft to blocks trims, splits list lines, and drops empty blocks', () => {
  const blocks = knowledgeDraftToBlocks([
    { id: 'h1', type: 'h', text: '  Heading  ' },
    { id: 'p-empty', type: 'p', text: '   ' },
    { id: 'l1', type: 'list', text: 'one\n\n  two  \nthree' },
    { id: 'l-empty', type: 'list', text: '\n   \n' },
  ])
  assert.deepEqual(blocks, [
    { id: 'h1', type: 'h', text: 'Heading' },
    { id: 'l1', type: 'list', items: ['one', 'two', 'three'] },
  ])
})

test('knowledge blocks to draft assigns a stable id when a block has none', () => {
  const drafts = knowledgePageBlocksToDraft([{ type: 'p', text: 'No id here.' }])
  assert.equal(drafts[0]?.id, 'block-1')
})
