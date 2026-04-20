import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { getCustomAgentSummaries } from '../apps/desktop/src/main/custom-agents.ts'
import { getMachineSkillsDir } from '../apps/desktop/src/main/runtime-paths.ts'
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
