import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getConfig, getConfigDir } from './config.js'
import { writeFileAtomic } from '@open-cowork/shared/node'
import { parseJsoncText } from '@open-cowork/shared'

export interface OpenCodeAgentInput {
  name: string
  model?: string
  variant?: string
  prompt?: string
  description?: string
  mode?: 'subagent' | 'primary' | 'all'
  temperature?: number
  maxSteps?: number
  hidden?: boolean
  disable?: boolean
  tools?: Record<string, boolean>
  permission?: Record<string, unknown>
  configDir?: string
}

export interface OpenCodeSkillInput {
  name: string
  content: string
  configDir?: string
}

export interface OpenCodeMcpInput {
  name: string
  server: Record<string, unknown>
  configDir?: string
}

export interface OpenCodeToolInput {
  name: string
  content: string
  extension?: 'ts' | 'js'
  configDir?: string
}

export function listOpenCodeAgents(configDir?: string): Record<string, unknown> {
  const config = readOpenCodeConfig(configDir)
  return { ...(config.agent || {}) }
}

export function upsertOpenCodeAgent(input: OpenCodeAgentInput): Record<string, unknown> {
  assertAssetName(input.name, 'agent')
  assertOptionalString(input.model, 'agent model')
  assertOptionalString(input.variant, 'agent variant')
  assertOptionalString(input.prompt, 'agent prompt')
  assertOptionalString(input.description, 'agent description')
  if (input.mode !== undefined && !['subagent', 'primary', 'all'].includes(input.mode)) throw new Error('agent mode must be subagent, primary, or all')
  assertOptionalFiniteNumber(input.temperature, 'agent temperature')
  assertOptionalInteger(input.maxSteps, 'agent maxSteps')
  if (input.hidden !== undefined && typeof input.hidden !== 'boolean') throw new Error('agent hidden must be boolean')
  if (input.disable !== undefined && typeof input.disable !== 'boolean') throw new Error('agent disable must be boolean')
  if (input.tools !== undefined && (!input.tools || typeof input.tools !== 'object' || Array.isArray(input.tools) || Object.values(input.tools).some(value => typeof value !== 'boolean'))) throw new Error('agent tools must be an object of boolean flags')
  if (input.permission !== undefined && (!input.permission || typeof input.permission !== 'object' || Array.isArray(input.permission))) throw new Error('agent permission must be an object')
  const configDir = resolveOpenCodeConfigDir(input.configDir)
  const config = readOpenCodeConfig(configDir)
  const current = (config.agent && typeof config.agent === 'object' ? config.agent[input.name] : {}) || {}
  config.agent = { ...(config.agent || {}), [input.name]: cleanObject({
    ...(typeof current === 'object' ? current : {}),
    model: input.model,
    variant: input.variant,
    prompt: input.prompt,
    description: input.description,
    mode: input.mode || 'subagent',
    temperature: input.temperature,
    maxSteps: input.maxSteps,
    hidden: input.hidden,
    disable: input.disable,
    tools: input.tools,
    permission: input.permission,
  }) }
  writeOpenCodeConfig(config, configDir)
  return config.agent[input.name]
}

export function deleteOpenCodeAgent(name: string, configDir?: string): boolean {
  assertAssetName(name, 'agent')
  const dir = resolveOpenCodeConfigDir(configDir)
  const config = readOpenCodeConfig(dir)
  if (!config.agent?.[name]) return false
  delete config.agent[name]
  writeOpenCodeConfig(config, dir)
  return true
}

export function listOpenCodeSkills(configDir?: string): Array<{ name: string; path: string }> {
  const dir = resolveOpenCodeConfigDir(configDir)
  const skillsDir = resolveSkillsDir(dir)
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
      .map(entry => ({ name: entry.name, path: path.join(skillsDir, entry.name, 'SKILL.md') }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function upsertOpenCodeSkill(input: OpenCodeSkillInput): { name: string; path: string } {
  assertAssetName(input.name, 'skill')
  if (typeof input.content !== 'string' || !input.content.trim()) throw new Error('skill content is required')
  const configDir = resolveOpenCodeConfigDir(input.configDir)
  ensureSkillsPath(configDir)
  const skillDir = path.join(resolveSkillsDir(configDir), input.name)
  fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 })
  const skillFile = path.join(skillDir, 'SKILL.md')
  backupExistingFile(skillFile)
  atomicWriteFile(skillFile, input.content)
  return { name: input.name, path: skillFile }
}

export function deleteOpenCodeSkill(name: string, configDir?: string): boolean {
  assertAssetName(name, 'skill')
  const skillDir = path.join(resolveSkillsDir(resolveOpenCodeConfigDir(configDir)), name)
  if (!fs.existsSync(skillDir)) return false
  fs.rmSync(skillDir, { recursive: true, force: true })
  return true
}

export function listOpenCodeMcp(configDir?: string): Record<string, unknown> {
  const config = readOpenCodeConfig(configDir)
  return { ...(config.mcp || {}) }
}

export function upsertOpenCodeMcp(input: OpenCodeMcpInput): Record<string, unknown> {
  assertAssetName(input.name, 'mcp')
  if (!input.server || typeof input.server !== 'object' || Array.isArray(input.server)) throw new Error('mcp server config must be an object')
  const configDir = resolveOpenCodeConfigDir(input.configDir)
  const config = readOpenCodeConfig(configDir)
  config.mcp = { ...(config.mcp || {}), [input.name]: cleanObject({ ...input.server }) }
  writeOpenCodeConfig(config, configDir)
  return config.mcp[input.name]
}

export function deleteOpenCodeMcp(name: string, configDir?: string): boolean {
  assertAssetName(name, 'mcp')
  const dir = resolveOpenCodeConfigDir(configDir)
  const config = readOpenCodeConfig(dir)
  if (!config.mcp?.[name]) return false
  delete config.mcp[name]
  writeOpenCodeConfig(config, dir)
  return true
}

export function listOpenCodeTools(configDir?: string): Array<{ name: string; path: string }> {
  const toolsDir = resolveToolsDir(resolveOpenCodeConfigDir(configDir))
  try {
    return fs.readdirSync(toolsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name))
      .map(entry => ({ name: path.basename(entry.name, path.extname(entry.name)), path: path.join(toolsDir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function upsertOpenCodeTool(input: OpenCodeToolInput): { name: string; path: string } {
  assertAssetName(input.name, 'tool')
  if (typeof input.content !== 'string' || !input.content.trim()) throw new Error('tool content is required')
  const extension = input.extension || 'ts'
  if (!['ts', 'js'].includes(extension)) throw new Error('tool extension must be ts or js')
  const configDir = resolveOpenCodeConfigDir(input.configDir)
  const toolsDir = resolveToolsDir(configDir)
  fs.mkdirSync(toolsDir, { recursive: true, mode: 0o700 })
  const toolFile = path.join(toolsDir, `${input.name}.${extension}`)
  backupExistingFile(toolFile)
  atomicWriteFile(toolFile, input.content)
  return { name: input.name, path: toolFile }
}

export function deleteOpenCodeTool(name: string, configDir?: string): boolean {
  assertAssetName(name, 'tool')
  const toolsDir = resolveToolsDir(resolveOpenCodeConfigDir(configDir))
  let deleted = false
  for (const extension of ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs']) {
    const file = path.join(toolsDir, `${name}.${extension}`)
    if (!fs.existsSync(file)) continue
    fs.rmSync(file, { force: true })
    deleted = true
  }
  return deleted
}

export function resolveOpenCodeConfigDir(configDir?: string): string {
  const configured = configDir || process.env['OPENCODE_CONFIG_DIR'] || getConfig().opencodeConfigDir
  const resolved = path.resolve(expandHome(configured || path.join(os.homedir(), '.config', 'opencode')))
  assertAllowedConfigDir(resolved)
  return resolved
}

function readOpenCodeConfig(configDir?: string): any {
  const dir = resolveOpenCodeConfigDir(configDir)
  const file = configPath(dir)
  try { return parseJsonc(fs.readFileSync(file, 'utf-8')) }
  catch (err: any) {
    if (err?.code === 'ENOENT') return { $schema: 'https://opencode.ai/config.json' }
    throw new Error(`OpenCode config is invalid: ${file}: ${err?.message || err}`)
  }
}

function writeOpenCodeConfig(config: any, configDir: string): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const file = configPath(configDir)
  backupExistingFile(file)
  atomicWriteFile(file, JSON.stringify(config, null, 2) + '\n')
}

function ensureSkillsPath(configDir: string): void {
  const config = readOpenCodeConfig(configDir)
  const skillsDir = path.join(configDir, 'skills')
  const paths = Array.isArray(config.skills?.paths) ? config.skills.paths : []
  if (!paths.some((value: string) => expandPath(value, configDir) === skillsDir || value === './skills')) {
    config.skills = { ...(config.skills || {}), paths: [...paths, './skills'] }
    writeOpenCodeConfig(config, configDir)
  }
  fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 })
}

function resolveSkillsDir(configDir: string): string {
  return path.join(configDir, 'skills')
}

function resolveToolsDir(configDir: string): string {
  return path.join(configDir, 'tools')
}

function assertAllowedConfigDir(configDir: string): void {
  const homeConfig = path.join(os.homedir(), '.config')
  const basename = path.basename(configDir)
  const explicit = [process.env['OPENCODE_CONFIG_DIR'], getConfig().opencodeConfigDir]
    .filter(Boolean)
    .map(value => path.resolve(expandHome(String(value))))
  const isExplicit = explicit.includes(configDir)
  const isOpenCodeProfile = path.dirname(configDir) === homeConfig && /^opencode(?:-[a-zA-Z0-9_-]+)?$/.test(basename)
  if (!isExplicit && !isOpenCodeProfile) throw new Error(`configDir must be an OpenCode profile directory: ${configDir}`)
  if (fs.existsSync(configDir) && fs.lstatSync(configDir).isSymbolicLink()) throw new Error(`configDir must not be a symlink: ${configDir}`)
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${label} must be a string`)
}

function assertOptionalFiniteNumber(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${label} must be a finite number`)
}

function assertOptionalInteger(value: unknown, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1)) throw new Error(`${label} must be a positive integer`)
}

function configPath(configDir: string): string {
  return path.join(configDir, 'opencode.jsonc')
}

function parseJsonc(text: string): any {
  try {
    return parseJsoncText(text)
  } catch {
    return JSON.parse(text)
  }
}

function backupExistingFile(file: string): void {
  if (!fs.existsSync(file)) return
  const backup = `${file}.bak`
  fs.copyFileSync(file, backup)
  try { fs.chmodSync(backup, 0o600) } catch {}
}

function atomicWriteFile(file: string, content: string): void {
  writeFileAtomic(file, content, { mode: 0o600 })
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(getConfigDir(), value)
}

function expandPath(value: string, baseDir: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value)
}

function assertAssetName(name: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`${label} name must be 1-64 letters, numbers, underscores, or dashes`)
}

function cleanObject<T extends Record<string, any>>(value: T): T {
  const out: Record<string, any> = {}
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v
  }
  return out as T
}
