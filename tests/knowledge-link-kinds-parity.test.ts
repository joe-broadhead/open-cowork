import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { KNOWLEDGE_LINK_KINDS } from '@open-cowork/shared'

// The bundled knowledge MCP hardcodes its link-kind enum because it ships without a runtime
// dependency on @open-cowork/shared. This guard fails if that deliberate copy drifts from the
// canonical KNOWLEDGE_LINK_KINDS — advertising a kind the store rejects (or hiding a valid one).
// See mcps/knowledge/src/index.ts and packages/shared/src/knowledge.ts (#925).
test('knowledge MCP link-kind enum matches @open-cowork/shared KNOWLEDGE_LINK_KINDS', () => {
  const source = readFileSync(new URL('../mcps/knowledge/src/index.ts', import.meta.url), 'utf8')
  const match = source.match(/kind:\s*z\.enum\(\[([^\]]+)\]\)/)
  assert.ok(match, 'expected a `kind: z.enum([...])` link schema in the knowledge MCP')
  const mcpKinds = match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/['"]/g, ''))
    .filter(Boolean)
  assert.deepEqual([...mcpKinds].sort(), [...KNOWLEDGE_LINK_KINDS].sort())
})
