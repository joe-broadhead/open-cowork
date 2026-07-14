import {
  pruneManagedSkillMirror,
  readCurrentManagedSkillMirrorNames,
  writeManagedSkillMirrorNames,
} from '@open-cowork/runtime-host/runtime-skill-mirror'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const registryName = '.open-cowork-managed-skills.json'

function writeSkill(root: string, name: string) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n`)
}

test('managed-skill mirrors trust only the exact current registry schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-managed-skill-registry-'))
  const discoverableSkillsDir = join(root, 'discoverable')
  const previousManagedSkillsDir = join(root, 'previous')

  try {
    writeSkill(discoverableSkillsDir, 'generated-skill')
    writeManagedSkillMirrorNames(discoverableSkillsDir, ['generated-skill'])
    assert.deepEqual([...readCurrentManagedSkillMirrorNames(discoverableSkillsDir)], ['generated-skill'])

    const registryPath = join(discoverableSkillsDir, registryName)
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, unknown>
    writeFileSync(registryPath, JSON.stringify({ ...registry, schemaVersion: 2 }))

    assert.deepEqual([...readCurrentManagedSkillMirrorNames(discoverableSkillsDir)], [])
    assert.deepEqual(pruneManagedSkillMirror({
      discoverableSkillsDir,
      previousManagedSkillsDir,
      configuredSkillNames: new Set(),
    }), [])
    assert.equal(existsSync(join(discoverableSkillsDir, 'generated-skill', 'SKILL.md')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed-skill mirrors reject the removed skillNames-only registry shape', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-managed-skill-legacy-registry-'))
  try {
    writeSkill(root, 'legacy-skill')
    writeFileSync(join(root, registryName), JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skillNames: ['legacy-skill'],
    }))

    assert.deepEqual([...readCurrentManagedSkillMirrorNames(root)], [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed-skill mirrors reject unknown registry and skill-entry fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-managed-skill-extra-fields-'))
  try {
    writeSkill(root, 'generated-skill')
    writeManagedSkillMirrorNames(root, ['generated-skill'])
    const path = join(root, registryName)
    const registry = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: number
      updatedAt: string
      skills: Array<Record<string, unknown>>
    }

    writeFileSync(path, JSON.stringify({ ...registry, skillNames: ['generated-skill'] }))
    assert.deepEqual([...readCurrentManagedSkillMirrorNames(root)], [])
    assert.deepEqual(pruneManagedSkillMirror({
      discoverableSkillsDir: root,
      previousManagedSkillsDir: join(root, 'previous'),
      configuredSkillNames: new Set(),
    }), [])
    assert.equal(existsSync(join(root, 'generated-skill', 'SKILL.md')), true)

    writeFileSync(path, JSON.stringify({
      ...registry,
      skills: registry.skills.map((entry) => ({ ...entry, legacyPath: 'generated-skill' })),
    }))
    assert.deepEqual([...readCurrentManagedSkillMirrorNames(root)], [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
