import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import type { CustomSkillConfig } from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'
import { log } from './logger.ts'
import { loadSettings, saveSettings } from './settings.ts'

let migratedLegacySkills = false

function isSafeRelativePath(value: string) {
  if (!value.trim()) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  const normalized = value.replace(/\\/g, '/')
  return !normalized.split('/').some((segment) => segment === '..' || segment === '')
}

export function getCustomSkillsDir() {
  const root = join(getAppDataDir(), 'skills')
  mkdirSync(root, { recursive: true })
  return root
}

function customSkillDir(name: string) {
  return join(getCustomSkillsDir(), name)
}

function listFiles(root: string, current = root): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = []
  if (!existsSync(current)) return files

  for (const entry of readdirSync(current)) {
    const fullPath = join(current, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      files.push(...listFiles(root, fullPath))
      continue
    }

    const filePath = relative(root, fullPath).replace(/\\/g, '/')
    if (filePath === 'SKILL.md') continue
    files.push({
      path: filePath,
      content: readFileSync(fullPath, 'utf-8'),
    })
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function migrateLegacySkillSettings() {
  if (migratedLegacySkills) return
  migratedLegacySkills = true

  const settings = loadSettings()
  if (!settings.customSkills?.length) return

  for (const skill of settings.customSkills) {
    saveCustomSkill(skill)
  }

  try {
    saveSettings({ customSkills: [] })
  } catch (err: any) {
    log('error', `Custom skill migration failed: ${err?.message}`)
  }
}

export function listCustomSkills(): CustomSkillConfig[] {
  migrateLegacySkillSettings()
  const root = getCustomSkillsDir()
  const entries = existsSync(root) ? readdirSync(root) : []
  const skills: CustomSkillConfig[] = []

  for (const entry of entries) {
    const skillRoot = join(root, entry)
    let stats
    try {
      stats = statSync(skillRoot)
    } catch {
      continue
    }
    if (!stats.isDirectory()) continue

    const skillFile = join(skillRoot, 'SKILL.md')
    if (!existsSync(skillFile)) continue

    skills.push({
      name: entry,
      content: readFileSync(skillFile, 'utf-8'),
      files: listFiles(skillRoot),
    })
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

export function getCustomSkill(name: string) {
  return listCustomSkills().find((skill) => skill.name === name) || null
}

export function saveCustomSkill(skill: CustomSkillConfig) {
  migrateLegacySkillSettings()
  const root = customSkillDir(skill.name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), skill.content)

  for (const file of skill.files || []) {
    if (!isSafeRelativePath(file.path)) {
      throw new Error(`Invalid skill file path: ${file.path}`)
    }
    const output = resolve(root, file.path)
    const outputRelative = relative(root, output)
    if (outputRelative.startsWith('..') || outputRelative.startsWith('/')) {
      throw new Error(`Skill file escapes bundle root: ${file.path}`)
    }
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, file.content)
  }

  return true
}

export function removeCustomSkill(name: string) {
  migrateLegacySkillSettings()
  rmSync(customSkillDir(name), { recursive: true, force: true })
  return true
}
