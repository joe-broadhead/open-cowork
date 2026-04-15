import test from 'node:test'
import assert from 'node:assert/strict'
import { getCapabilityTool, listCapabilitySkills, listCapabilityTools } from '../apps/desktop/src/main/capability-catalog.ts'

test('built-in capabilities expose discoverable metadata without source parsing', async () => {
  const tools = listCapabilityTools()
  const charts = getCapabilityTool('charts')
  const skills = await listCapabilitySkills()

  assert.equal(tools.some((tool) => tool.id === 'charts'), true)
  assert.equal(tools.some((tool) => tool.id === 'skills'), true)
  assert.equal(charts?.namespace, 'charts')
  assert.equal(charts?.patterns.includes('mcp__charts__*'), true)
  assert.deepEqual(charts?.availableTools || [], [])
  assert.equal(skills.some((skill) => skill.name === 'chart-creator'), true)
  assert.equal(skills.some((skill) => skill.name === 'skill-creator'), true)
  assert.equal(skills.find((skill) => skill.name === 'chart-creator')?.origin, 'open-cowork')
})
