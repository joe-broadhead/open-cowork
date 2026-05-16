import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { getCustomAgentSummaries } from '../apps/desktop/src/main/custom-agents.ts'
import { getMachineAgentsDir, getMachineSkillsDir } from '../apps/desktop/src/main/runtime-paths.ts'
import { removeCustomAgent, saveCustomAgent } from '../apps/desktop/src/main/native-customizations.ts'

test('custom agent summaries keep agents visible when app-owned skills need frontmatter healing', async () => {
  const tempUserData = mkdtempSync(join(tmpdir(), 'opencowork-agent-regression-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  process.env.OPEN_COWORK_USER_DATA_DIR = tempUserData
  clearConfigCaches()

  const skillRoot = join(getMachineSkillsDir(), 'analyst')
  mkdirSync(skillRoot, { recursive: true })
  writeFileSync(
    join(skillRoot, 'SKILL.md'),
    '---\nname: mcp-analyst\ndescription: "Analyze metrics and answer business questions."\ntoolIds: ["nova"]\n---\n# Analyst\n',
  )

  saveCustomAgent(
    {
      scope: 'machine',
      directory: null,
      name: 'data-analyst',
      description: 'Answer business questions with evidence.',
      instructions: 'Use the analyst skill before answering.',
      skillNames: ['analyst'],
      toolIds: [],
      enabled: true,
      color: 'info',
    },
    {
      skill: { analyst: 'allow' },
      question: 'allow',
      edit: 'deny',
      bash: 'deny',
    },
  )

  try {
    const summaries = await getCustomAgentSummaries()
    const analyst = summaries.find((agent) => agent.name === 'data-analyst')

    assert.ok(analyst, 'agent should still be listed')
    assert.equal(analyst?.valid, true)
    assert.deepEqual(analyst?.skillNames, ['analyst'])
    assert.match(readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8'), /^---\nname: analyst\n/m)
  } finally {
    removeCustomAgent({ scope: 'machine', directory: null, name: 'data-analyst' })
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempUserData, { recursive: true, force: true })
  }
})

test('custom agent markdown carries SDK-native inference fields without config.agent duplication', () => {
  const tempUserData = mkdtempSync(join(tmpdir(), 'opencowork-agent-frontmatter-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  process.env.OPEN_COWORK_USER_DATA_DIR = tempUserData
  clearConfigCaches()

  saveCustomAgent(
    {
      scope: 'machine',
      directory: null,
      name: 'market-analyst',
      description: 'Analyze market signals.',
      instructions: 'Use the analyst skill before answering.',
      skillNames: [],
      toolIds: [],
      enabled: true,
      color: 'info',
      model: 'openrouter/anthropic/claude-sonnet-4',
      variant: 'reasoning',
      temperature: 0.2,
      top_p: 0.9,
      steps: 25,
      options: { reasoningEffort: 'high' },
    },
    {
      question: 'allow',
      edit: 'deny',
      bash: 'deny',
    },
  )

  try {
    const markdown = readFileSync(join(getMachineAgentsDir(), 'market-analyst.md'), 'utf-8')
    assert.match(markdown, /^color: "info"$/m)
    assert.match(markdown, /^model: "openrouter\/anthropic\/claude-sonnet-4"$/m)
    assert.match(markdown, /^variant: "reasoning"$/m)
    assert.match(markdown, /^temperature: 0\.2$/m)
    assert.match(markdown, /^top_p: 0\.9$/m)
    assert.match(markdown, /^steps: 25$/m)
    assert.match(markdown, /^options: \{"reasoningEffort":"high"\}$/m)
    assert.match(markdown, /^permission:$/m)
  } finally {
    removeCustomAgent({ scope: 'machine', directory: null, name: 'market-analyst' })
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempUserData, { recursive: true, force: true })
  }
})
