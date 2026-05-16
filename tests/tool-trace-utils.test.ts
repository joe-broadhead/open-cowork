import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TOOL_TRACE_RULES } from '../packages/shared/src/tool-trace.ts'
import {
  buildCustomMcpToolTraceRules,
  summarizeTools,
  toolCategory,
  tryParseChartOutput,
} from '../apps/desktop/src/renderer/components/chat/tool-trace-utils.ts'

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

test('tool trace rules can be configured ahead of the defaults', () => {
  const rules = [
    {
      id: 'ticket',
      label: 'ticket action',
      pluralLabel: 'ticket actions',
      match: [{ prefixes: ['mcp__jira__', 'jira_'] }],
    },
    ...DEFAULT_TOOL_TRACE_RULES,
  ]

  assert.equal(toolCategory('mcp__jira__create_issue', rules), 'ticket')
  assert.equal(
    summarizeTools([
      { name: 'mcp__jira__create_issue' },
      { name: 'jira_transition_issue' },
      { name: 'read' },
    ], rules),
    '2 ticket actions, 1 file read',
  )
})

test('custom MCP metadata creates project-specific trace grouping rules', () => {
  const rules = buildCustomMcpToolTraceRules([{
    name: 'ticketing',
    label: 'Ticketing',
    traceLabel: 'ticket update',
    tracePluralLabel: 'ticket updates',
  }])

  assert.equal(toolCategory('mcp__ticketing__create_issue', rules), 'custom-mcp:ticketing')
  assert.equal(
    summarizeTools([
      { name: 'mcp__ticketing__create_issue' },
      { name: 'ticketing_transition_issue' },
    ], rules),
    '2 ticket updates',
  )
})
