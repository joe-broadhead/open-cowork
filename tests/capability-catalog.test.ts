import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getCapabilityTool, listCapabilitySkills, listCapabilityTools } from '../apps/desktop/src/main/capability-catalog.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { getMachineSkillsDir } from '../apps/desktop/src/main/runtime-paths.ts'

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

test('capability skills exclude invalid custom bundles that the OpenCode runtime would not discover', async () => {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  const tempUserData = mkdtempSync(join(parent, 'opencowork-capability-skills-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  process.env.OPEN_COWORK_USER_DATA_DIR = tempUserData
  clearConfigCaches()

  const invalidRoot = join(getMachineSkillsDir(), 'Bad_Skill')
  mkdirSync(invalidRoot, { recursive: true })
  writeFileSync(join(invalidRoot, 'SKILL.md'), '---\nname: Bad_Skill\ndescription: "Invalid"\n---\n# Bad Skill')

  try {
    const skills = await listCapabilitySkills()
    assert.equal(skills.some((skill) => skill.name === 'Bad_Skill'), false)
    assert.equal(skills.some((skill) => skill.name === 'chart-creator'), true)
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    rmSync(tempUserData, { recursive: true, force: true })
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
  }
})
