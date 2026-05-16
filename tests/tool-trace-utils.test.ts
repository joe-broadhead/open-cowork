import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TOOL_TRACE_RULES } from '../packages/shared/src/tool-trace.ts'
import {
  buildCustomMcpToolTraceRules,
  summarizeTools,
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

test('summarizeTools classifies key runtime tool families', () => {
  assert.equal(summarizeTools([{ name: 'read' }]), '1 file read')
  assert.equal(summarizeTools([{ name: 'bash' }]), '1 command')
  assert.equal(summarizeTools([{ name: 'charts_mermaid' }]), '1 chart')
  assert.equal(summarizeTools([{ name: 'mcp__nova__get_context' }]), '1 inspection')
  assert.equal(summarizeTools([{ name: 'mcp__github__pull_request_read' }]), '1 github PR action')
  assert.equal(summarizeTools([{ name: 'mcp__perplexity__perplexity_research' }]), '1 perplexity research run')
  assert.equal(summarizeTools([{ name: 'mcp__google-drive__list_files' }]), '1 drive action')
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

  assert.equal(
    summarizeTools([
      { name: 'mcp__ticketing__create_issue' },
      { name: 'ticketing_transition_issue' },
    ], rules),
    '2 ticket updates',
  )
})
