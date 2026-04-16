import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeTools, toolCategory, tryParseChartOutput } from '../apps/desktop/src/renderer/components/chat/tool-trace-utils.ts'

test('tryParseChartOutput parses stringified vega specs and mermaid diagrams', () => {
  const vega = tryParseChartOutput(JSON.stringify({
    type: 'vega-lite',
    spec: JSON.stringify({ mark: 'bar' }),
    title: 'Chart',
  }))
  assert.deepEqual(vega, {
    type: 'vega-lite',
    spec: { mark: 'bar' },
    title: 'Chart',
  })

  const mermaid = tryParseChartOutput({
    type: 'mermaid',
    diagram: 'graph TD; A-->B;',
    title: 'Flow',
  })
  assert.deepEqual(mermaid, {
    type: 'mermaid',
    diagram: 'graph TD; A-->B;',
    title: 'Flow',
  })

  assert.equal(tryParseChartOutput('not-json'), null)
  assert.equal(tryParseChartOutput({ type: 'vega', spec: '{bad json}' }), null)
})

test('toolCategory classifies key runtime tool families', () => {
  assert.equal(toolCategory('read'), 'file read')
  assert.equal(toolCategory('bash'), 'command')
  assert.equal(toolCategory('charts_mermaid'), 'chart')
  assert.equal(toolCategory('mcp__nova__get_context'), 'inspection')
  assert.equal(toolCategory('mcp__github__pull_request_read'), 'github pr')
  assert.equal(toolCategory('mcp__perplexity__perplexity_research'), 'perplexity research')
  assert.equal(toolCategory('mcp__google-drive__list_files'), 'drive action')
})

test('summarizeTools groups repeated tool categories into readable text', () => {
  const summary = summarizeTools([
    { name: 'read' },
    { name: 'grep' },
    { name: 'charts_mermaid' },
    { name: 'mcp__github__pull_request_read' },
    { name: 'mcp__github__issue_read' },
    { name: 'mcp__perplexity__perplexity_research' },
    { name: 'mcp__perplexity__perplexity_research' },
  ])

  assert.equal(
    summary,
    '1 file read, 1 file search, 1 chart, 1 github PR action, 1 github issue action, 2 perplexity research runs',
  )
})
