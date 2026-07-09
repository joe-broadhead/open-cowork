import { getMachineSkillsDir } from '@open-cowork/runtime-host/runtime-paths'
import { getCapabilitySkillBundle, getCapabilityTool, listCapabilitySkills, listCapabilityTools } from '@open-cowork/runtime-host/capability-catalog'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
test('built-in capabilities expose discoverable metadata without source parsing', async () => {
  const tools = await listCapabilityTools()
  const charts = await getCapabilityTool('charts')
  const skills = await listCapabilitySkills()
  const autoresearchBundle = await getCapabilitySkillBundle('autoresearch')

  assert.equal(tools.some((tool) => tool.id === 'charts'), true)
  assert.equal(tools.some((tool) => tool.id === 'clock'), true)
  assert.equal(tools.some((tool) => tool.id === 'skills'), true)
  assert.equal(tools.some((tool) => tool.id === 'agents'), true)
  assert.equal(charts?.namespace, 'charts')
  assert.equal(charts?.patterns.includes('mcp__charts__*'), true)
  assert.deepEqual(charts?.availableTools || [], [])
  assert.equal(skills.some((skill) => skill.name === 'autoresearch'), true)
  assert.equal(skills.some((skill) => skill.name === 'agent-creator'), true)
  assert.equal(skills.some((skill) => skill.name === 'chart-creator'), true)
  assert.equal(skills.some((skill) => skill.name === 'clock'), true)
  assert.equal(skills.some((skill) => skill.name === 'skill-creator'), true)
  assert.equal(skills.some((skill) => skill.name === 'workflow-creator'), true)
  assert.deepEqual(skills.find((skill) => skill.name === 'autoresearch')?.toolIds, ['charts', 'skills', 'agents'])
  assert.deepEqual(skills.find((skill) => skill.name === 'agent-creator')?.toolIds, ['agents'])
  assert.deepEqual(skills.find((skill) => skill.name === 'clock')?.toolIds, ['clock'])
  assert.deepEqual(skills.find((skill) => skill.name === 'workflow-creator')?.toolIds, ['workflows'])
  assert.equal(skills.find((skill) => skill.name === 'chart-creator')?.origin, 'open-cowork')
  assert.equal(autoresearchBundle?.files.some((file) => file.path === 'references/eval-guide.md'), true)
})

test('capability skills exclude invalid custom bundles that the OpenCode runtime would not discover', async () => {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  const tempUserData = mkdtempSync(join(parent, 'open-cowork-capability-skills-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  process.env.OPEN_COWORK_USER_DATA_DIR = tempUserData
  clearConfigCaches()

  const invalidRoot = join(getMachineSkillsDir(), 'Bad_Skill')
  mkdirSync(invalidRoot, { recursive: true })
  writeFileSync(join(invalidRoot, 'SKILL.md'), '---\nname: Bad_Skill\ndescription: "Invalid"\n---\n# Bad Skill')

  try {
    const skills = await listCapabilitySkills()
    assert.equal(skills.some((skill) => skill.name === 'Bad_Skill'), false)
    assert.equal(skills.some((skill) => skill.name === 'agent-creator'), true)
    assert.equal(skills.some((skill) => skill.name === 'autoresearch'), true)
    assert.equal(skills.some((skill) => skill.name === 'chart-creator'), true)
    assert.equal(skills.some((skill) => skill.name === 'clock'), true)
    assert.equal(skills.some((skill) => skill.name === 'workflow-creator'), true)
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    rmSync(tempUserData, { recursive: true, force: true })
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
  }
})
