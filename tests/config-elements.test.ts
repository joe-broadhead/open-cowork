import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertConfigValid,
  clearConfigCaches,
  getConfiguredAgentsFromConfig,
  getConfiguredMcpsFromConfig,
  getConfiguredSkillsFromConfig,
  getConfiguredToolsFromConfig,
  getConfigError,
  getConfiguredToolAskPatterns,
} from '../apps/desktop/src/main/config-loader.ts'

test('open core ships with built-in tools, skills, mcps, and agents configured by default', () => {
  const tools = getConfiguredToolsFromConfig()
  const skills = getConfiguredSkillsFromConfig()
  const mcps = getConfiguredMcpsFromConfig()
  const agents = getConfiguredAgentsFromConfig()

  assert.equal(tools.map((tool) => tool.id).join(','), 'charts,skills')
  assert.equal(skills.map((skill) => skill.sourceName).join(','), 'chart-creator,skill-creator')
  assert.equal(mcps.map((mcp) => mcp.name).join(','), 'charts,skills')
  assert.equal(agents.map((agent) => agent.name).join(','), 'charts,skill-builder')
  assert.equal(getConfiguredToolAskPatterns(tools.find((tool) => tool.id === 'skills')!).includes('mcp__skills__save_skill_bundle'), true)
})

test('invalid config fails fast with a readable validation error', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    tools: [
      {
        id: 'broken-tool',
        description: 'Missing required fields should fail validation',
      },
    ],
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    assert.throws(() => assertConfigValid(), /Invalid Open Cowork config/)
    assert.match(getConfigError() || '', /tools\[0\].name|tools\[0\].kind/)
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
