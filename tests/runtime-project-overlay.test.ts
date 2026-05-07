import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { clearConfigCaches, getSidecarJsonSuffix } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearProjectOverlayCopies,
  projectHasOverlayContent,
  syncProjectOverlayToRuntime,
} from '../apps/desktop/src/main/runtime-project-overlay.ts'
import {
  getMachineAgentsDir,
  getMachineSkillsDir,
  getProjectCoworkAgentsDir,
  getProjectCoworkSkillsDir,
} from '../apps/desktop/src/main/runtime-paths.ts'

function skillContent(label: string) {
  return `---\ndescription: ${JSON.stringify(label)}\n---\n\nUse this skill for ${label}.\n`
}

function agentContent(label: string) {
  return `---\ndescription: ${JSON.stringify(label)}\nmode: subagent\npermission:\n  bash: ask\n---\n\nHandle ${label} tasks.\n`
}

test('project overlay copies project-scoped skills and agents then restores machine content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-project-overlay-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = join(root, 'user-data')
  const projectDir = join(root, 'project')

  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()

    const machineSkillDir = join(getMachineSkillsDir(), 'brief-maker')
    const machineAgentDir = getMachineAgentsDir()
    const projectSkillDir = join(getProjectCoworkSkillsDir(projectDir), 'brief-maker')
    const projectAgentDir = getProjectCoworkAgentsDir(projectDir)
    const sidecarName = `brief-writer${getSidecarJsonSuffix()}`

    await mkdir(machineSkillDir, { recursive: true })
    await mkdir(machineAgentDir, { recursive: true })
    await mkdir(projectSkillDir, { recursive: true })
    await mkdir(projectAgentDir, { recursive: true })

    writeFileSync(join(machineSkillDir, 'SKILL.md'), skillContent('machine skill'))
    writeFileSync(join(machineAgentDir, 'brief-writer.md'), agentContent('machine agent'))
    writeFileSync(join(machineAgentDir, sidecarName), `${JSON.stringify({ color: 'blue' }, null, 2)}\n`)

    writeFileSync(join(projectSkillDir, 'SKILL.md'), skillContent('project skill'))
    writeFileSync(join(projectAgentDir, 'brief-writer.md'), agentContent('project agent'))
    writeFileSync(join(projectAgentDir, sidecarName), `${JSON.stringify({ color: 'green' }, null, 2)}\n`)

    assert.equal(projectHasOverlayContent(projectDir), true)
    assert.equal(projectHasOverlayContent(join(root, 'empty-project')), false)

    assert.equal(syncProjectOverlayToRuntime(projectDir), projectDir)
    assert.match(readFileSync(join(machineSkillDir, 'SKILL.md'), 'utf-8'), /project skill/)
    assert.match(readFileSync(join(machineAgentDir, 'brief-writer.md'), 'utf-8'), /project agent/)
    assert.match(readFileSync(join(machineAgentDir, sidecarName), 'utf-8'), /green/)

    clearProjectOverlayCopies()

    assert.equal(existsSync(machineSkillDir), true)
    assert.match(readFileSync(join(machineSkillDir, 'SKILL.md'), 'utf-8'), /machine skill/)
    assert.match(readFileSync(join(machineAgentDir, 'brief-writer.md'), 'utf-8'), /machine agent/)
    assert.match(readFileSync(join(machineAgentDir, sidecarName), 'utf-8'), /blue/)
  } finally {
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
})
