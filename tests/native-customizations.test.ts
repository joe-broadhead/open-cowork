import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  listCustomAgents,
  removeCustomMcp,
  saveCustomMcp,
} from '../apps/desktop/src/main/native-customizations.ts'

test('project-scoped MCP edits preserve JSONC comments and unrelated keys', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'opencowork-native-config-'))
  const configPath = join(projectRoot, 'opencode.jsonc')

  writeFileSync(configPath, `{
  // keep this comment
  "theme": "keep",
  "mcp": {
    "existing": {
      "type": "remote",
      "url": "https://example.test/mcp"
    }
  }
}
`)

  try {
    saveCustomMcp({
      scope: 'project',
      directory: projectRoot,
      name: 'warehouse',
      label: 'Warehouse',
      description: 'Warehouse MCP',
      type: 'http',
      url: 'https://warehouse.example.test/mcp',
    })

    let updated = readFileSync(configPath, 'utf-8')
    assert.match(updated, /keep this comment/)
    assert.match(updated, /"theme": "keep"/)
    assert.match(updated, /"existing"/)
    assert.match(updated, /"warehouse"/)

    removeCustomMcp({
      scope: 'project',
      directory: projectRoot,
      name: 'warehouse',
    })

    updated = readFileSync(configPath, 'utf-8')
    assert.match(updated, /keep this comment/)
    assert.match(updated, /"theme": "keep"/)
    assert.match(updated, /"existing"/)
    assert.doesNotMatch(updated, /"warehouse"/)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('custom agents derive tool and skill selections from native markdown permissions without a sidecar', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'opencowork-native-agents-'))
  const agentsDir = join(projectRoot, '.opencode', 'agents')
  const configPath = join(projectRoot, 'opencode.json')

  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify({
    mcp: {
      warehouse: {
        type: 'remote',
        url: 'https://warehouse.example.test/mcp',
      },
    },
  }, null, 2))
  writeFileSync(join(agentsDir, 'insights.md'), `---
description: "Investigate dashboards and chart data"
mode: subagent
permission:
  skill:
    "chart-creator": allow
  "mcp__charts__*": allow
  "mcp__warehouse__run_query": ask
---

Work carefully.
`)

  try {
    const agent = listCustomAgents({ directory: projectRoot }).find((entry) => entry.name === 'insights')
    assert.ok(agent)
    assert.deepEqual(agent.skillNames, ['chart-creator'])
    assert.deepEqual(agent.toolIds, ['charts', 'warehouse'])
    assert.equal(agent.color, 'accent')
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})
