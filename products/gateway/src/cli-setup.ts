#!/usr/bin/env node
import * as readline from 'node:readline'
import { stableStringifyDefined } from './stable-stringify.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { isSupportedNodeVersion } from './quickstart.js'
import { clearConfigCacheForTest, getConfig, getConfigDir, getConfigPath, writeConfig, type GatewayConfig } from './config.js'
import { defaultGatewayEnvironmentConfig } from './environments.js'
import { ensureLocalHttpAdminTokenFile, redactSecret } from './security.js'
import { installGatewayOpenCodeAssets } from './opencode-defaults.js'
import { DEFAULT_ROUTING } from './routing.js'
import { workStatePath } from './work-store.js'

type SetupMode = 'setup' | 'update'

export interface SetupAnswers {
  opencodeUrl: string
  httpPort: number
  opencodeConfigDir?: string
  plannerModel: string
  workerModel: string
  heartbeatIntervalSeconds: number
  maxWorkers: number
  telegramBotToken?: string
  whatsappAccessToken?: string
  whatsappPhoneNumberId?: string
  whatsappVerifyToken?: string
  whatsappAppSecret?: string
}

export interface SetupApplyResult {
  mode: SetupMode
  configPath: string
  routingPath: string
  statePath: string
  configChanged: boolean
  routingChanged: boolean
  openCodeAssets?: { skills: string[]; agents: string[]; mcp: string }
  changes: string[]
  warnings: string[]
  config: GatewayConfig
}

interface RunSetupOptions {
  mode?: SetupMode
  interactive?: boolean
  installAssets?: boolean
}

export async function runSetup(options: RunSetupOptions = {}) {
  return runSetupCommand({ mode: 'setup', interactive: true, installAssets: true, ...options })
}

export async function runUpdate(options: RunSetupOptions = {}) {
  return runSetupCommand({ mode: 'update', interactive: false, installAssets: true, ...options })
}

async function runSetupCommand(options: Required<RunSetupOptions>) {
  const preflight = checkSetupPrerequisites()
  const hadConfig = fs.existsSync(getConfigPath())
  const current = loadCurrentConfig(options.mode)
  const answers = options.interactive ? await promptForSetupAnswers(current, options.mode) : defaultSetupAnswers(current)
  const result = applySetupState(answers, {
    mode: options.mode,
    installAssets: options.installAssets,
    hadConfig,
    current,
  })
  await initializeGatewayState()

  printSetupResult(result, preflight)
  return result
}

export function applySetupState(
  answers: SetupAnswers,
  options: { mode?: SetupMode; installAssets?: boolean; hadConfig?: boolean; current?: GatewayConfig } = {},
): SetupApplyResult {
  const mode = options.mode || 'setup'
  const hadConfig = options.hadConfig ?? fs.existsSync(getConfigPath())
  const current = options.current || getConfig()
  const next = buildConfigFromAnswers(current, answers)
  const before = hadConfig ? configComparable(current) : undefined
  const after = configComparable(next)
  const configChanged = !hadConfig || before !== after

  if (configChanged) writeConfig(next)
  else clearConfigCacheForTest()

  const routing = ensureRoutingFile()
  // Provision the local HTTP admin token so `setup` alone leaves the CLI able to
  // perform authenticated WRITE calls (task add, dispatch, quickstart) against a
  // daemon running under the hardened `capabilityScopedLoopback` default. Benign
  // + idempotent; the secret value is never printed.
  try { ensureLocalHttpAdminTokenFile() } catch {}
  const openCodeAssets = options.installAssets === false ? undefined : installGatewayOpenCodeAssets(next.opencodeConfigDir)
  const statePath = workStatePath()
  const changes = describeSetupChanges(current, next, { hadConfig, configChanged, routingChanged: routing.changed, mode })
  const warnings = validatePrivateAlphaConfig(next, { hadConfig })

  return {
    mode,
    configPath: getConfigPath(),
    routingPath: routing.path,
    statePath,
    configChanged,
    routingChanged: routing.changed,
    openCodeAssets,
    changes,
    warnings,
    config: next,
  }
}

export function defaultSetupAnswers(config: GatewayConfig = getConfig()): SetupAnswers {
  return {
    opencodeUrl: config.opencodeUrl,
    httpPort: config.httpPort,
    opencodeConfigDir: config.opencodeConfigDir,
    plannerModel: formatModelRef(config.profiles['planner']?.model) || 'openrouter/deepseek/deepseek-v4-pro',
    workerModel: formatModelRef(config.profiles['implementer']?.model) || 'openrouter/deepseek/deepseek-v4-flash',
    heartbeatIntervalSeconds: Math.max(1, Math.round(config.heartbeat.intervalMs / 1000)),
    maxWorkers: config.scheduler.maxConcurrent,
    telegramBotToken: config.channels.telegram.botToken,
    whatsappAccessToken: config.channels.whatsapp.accessToken,
    whatsappPhoneNumberId: config.channels.whatsapp.phoneNumberId,
    whatsappVerifyToken: config.channels.whatsapp.verifyToken,
    whatsappAppSecret: config.channels.whatsapp.appSecret,
  }
}

async function promptForSetupAnswers(config: GatewayConfig, mode: SetupMode): Promise<SetupAnswers> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const defaults = defaultSetupAnswers(config)
  const ask = (q: string, def: string): Promise<string> => new Promise(resolve => {
    rl.question(`  ${q} [${def}]: `, answer => resolve(answer.trim() || def))
  })
  const askOptional = (q: string, def?: string): Promise<string | undefined> => new Promise(resolve => {
    const label = def ? 'configured, Enter keeps current' : 'empty'
    rl.question(`  ${q} [${label}]: `, answer => resolve(answer.trim() || def))
  })

  console.log()
  console.log(`  OpenCode Gateway - ${mode === 'setup' ? 'Setup Wizard' : 'Update Wizard'}`)
  console.log('  ==================================')
  console.log()

  console.log('  -- OpenCode integration --')
  const opencodeUrl = await ask('OpenCode server URL', defaults.opencodeUrl)
  const opencodeConfigDir = await askOptional('OpenCode config directory override', defaults.opencodeConfigDir)
  console.log()

  console.log('  -- Gateway service --')
  const httpPort = parseInteger(await ask('Dashboard/service HTTP port', String(defaults.httpPort)), 'Gateway HTTP port')
  const heartbeatIntervalSeconds = parseInteger(await ask('Heartbeat interval (seconds)', String(defaults.heartbeatIntervalSeconds)), 'Heartbeat interval')
  const maxWorkers = parseInteger(await ask('Max concurrent task stages', String(defaults.maxWorkers)), 'Max concurrent task stages')
  console.log()

  console.log('  -- AI Models --')
  console.log('  Format: provider/model (for example openrouter/deepseek/deepseek-v4-pro)')
  const plannerModel = await ask('Planner/coordinator model', defaults.plannerModel)
  const workerModel = await ask('Implementer model', defaults.workerModel)
  console.log()

  console.log('  -- Channels and secrets --')
  console.log('  Leave secrets empty to skip them or keep the existing configured value.')
  const telegramBotToken = await askOptional('Telegram bot token', defaults.telegramBotToken)
  const whatsappAccessToken = await askOptional('WhatsApp access token', defaults.whatsappAccessToken)
  const whatsappPhoneNumberId = await askOptional('WhatsApp phone number ID', defaults.whatsappPhoneNumberId)
  const whatsappVerifyToken = await askOptional('WhatsApp verify token', defaults.whatsappVerifyToken)
  const whatsappAppSecret = await askOptional('WhatsApp app secret', defaults.whatsappAppSecret)
  console.log()
  rl.close()

  return {
    opencodeUrl,
    opencodeConfigDir,
    httpPort,
    heartbeatIntervalSeconds,
    maxWorkers,
    plannerModel,
    workerModel,
    telegramBotToken,
    whatsappAccessToken,
    whatsappPhoneNumberId,
    whatsappVerifyToken,
    whatsappAppSecret,
  }
}

function buildConfigFromAnswers(current: GatewayConfig, answers: SetupAnswers): GatewayConfig {
  const [plannerProvider, plannerModelId] = parseModelRef(answers.plannerModel, 'Planner model')
  const [workerProvider, workerModelId] = parseModelRef(answers.workerModel, 'Implementer model')
  const heartbeatMs = answers.heartbeatIntervalSeconds * 1000
  const next: GatewayConfig = {
    ...current,
    opencodeConfigDir: normalizeOptionalPath(answers.opencodeConfigDir),
    opencodeUrl: answers.opencodeUrl.trim(),
    httpPort: answers.httpPort,
    heartbeat: { intervalMs: heartbeatMs },
    channelSync: current.channelSync || { enabled: true, intervalMs: 3000, includeUserMessages: true },
    security: current.security || {
      httpHost: '127.0.0.1',
      allowNonLocalHttp: false,
      publicWebhookMode: false,
      unsafeAllowNoAuth: false,
      channelAllowlists: { telegram: [], whatsapp: [], discord: [] },
      unsafeAllowAllChannelTargets: { telegram: false, whatsapp: false, discord: false },
    },
    governance: current.governance || {
      enabled: true,
      action: 'block',
      global: {},
      roadmaps: {},
      tasks: {},
      stages: {},
      runtime: { maxRunMs: 0, staleRunMs: 60 * 60 * 1000 },
    },
    humanLoop: current.humanLoop || {
      enabled: true,
      taskStartApproval: false,
      stageApprovals: [],
      externalSideEffectApproval: true,
      budgetExceptionApproval: true,
      destructiveActionApproval: true,
      credentialUseApproval: true,
      defaultTimeoutMs: 24 * 60 * 60 * 1000,
      timeoutAction: 'escalate',
      priorityTimeoutMs: { HIGH: 60 * 60 * 1000, MEDIUM: 4 * 60 * 60 * 1000, LOW: 24 * 60 * 60 * 1000 },
    },
    environments: current.environments || defaultGatewayEnvironmentConfig(),
    scheduler: {
      ...current.scheduler,
      maxConcurrent: answers.maxWorkers,
    },
    profiles: { ...current.profiles },
    agentTeams: current.agentTeams || {},
    agentFactory: current.agentFactory || { blueprintDirs: [] },
    channels: {
      richMessages: { enabled: current.channels?.richMessages?.enabled !== false },
      telegram: {
        ...current.channels?.telegram,
        botToken: normalizeOptionalSecret(answers.telegramBotToken),
        richMessages: { enabled: current.channels?.telegram?.richMessages?.enabled !== false },
      },
      whatsapp: {
        ...current.channels?.whatsapp,
        accessToken: normalizeOptionalSecret(answers.whatsappAccessToken),
        phoneNumberId: normalizeOptionalSecret(answers.whatsappPhoneNumberId),
        verifyToken: normalizeOptionalSecret(answers.whatsappVerifyToken),
        appSecret: normalizeOptionalSecret(answers.whatsappAppSecret),
      },
      discord: {
        ...current.channels?.discord,
        enabled: current.channels?.discord?.enabled === true,
        richMessages: { enabled: current.channels?.discord?.richMessages?.enabled !== false },
      },
    },
  }

  next.profiles['planner'] = profileWithModel(next.profiles['planner']!, plannerProvider, plannerModelId, heartbeatMs)
  next.profiles['coordinator'] = profileWithModel(next.profiles['coordinator']!, plannerProvider, plannerModelId, 0)
  next.profiles['auditor'] = profileWithModel(next.profiles['auditor']!, plannerProvider, plannerModelId, 0)
  next.profiles['implementer'] = profileWithModel(next.profiles['implementer']!, workerProvider, workerModelId, 0)

  return next
}

function profileWithModel(profile: GatewayConfig['profiles'][string], providerID: string, modelID: string, heartbeatMs: number) {
  const variant = profile.model.providerID === providerID && profile.model.modelID === modelID ? profile.model.variant : undefined
  return {
    ...profile,
    model: { providerID, modelID, ...(variant ? { variant } : {}) },
    heartbeatMs,
  }
}

function ensureRoutingFile(): { path: string; changed: boolean } {
  const routingPath = path.join(getConfigDir(), 'routing.json')
  if (fs.existsSync(routingPath)) return { path: routingPath, changed: false }
  fs.mkdirSync(path.dirname(routingPath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(routingPath, JSON.stringify(DEFAULT_ROUTING, null, 2) + '\n', { mode: 0o600 })
  return { path: routingPath, changed: true }
}

async function initializeGatewayState(): Promise<void> {
  const work = await import('./work-store.js')
  work.loadWorkState()
}

function printSetupResult(result: SetupApplyResult, preflight: string[]) {
  console.log()
  console.log(result.mode === 'setup' ? '  Setup complete.' : '  Update complete.')
  console.log()
  preflight.forEach(line => console.log(`  ${line}`))
  console.log(`  Config:    ${result.configPath} (${result.configChanged ? 'updated' : 'unchanged'})`)
  console.log(`  Routing:   ${result.routingPath} (${result.routingChanged ? 'created' : 'unchanged'})`)
  console.log(`  State:     ${result.statePath} (initialized)`)
  if (result.openCodeAssets) {
    console.log(`  OpenCode:  installed ${result.openCodeAssets.mcp} MCP, ${result.openCodeAssets.agents.length} agents, ${result.openCodeAssets.skills.length} skills`)
  }
  console.log(`  Telegram: ${result.config.channels.telegram.botToken ? redactSecret(result.config.channels.telegram.botToken) : 'not configured'}`)
  console.log(`  WhatsApp: ${result.config.channels.whatsapp.accessToken ? redactSecret(result.config.channels.whatsapp.accessToken) : 'not configured'}`)
  if (result.changes.length) {
    console.log()
    console.log('  Changes:')
    result.changes.forEach(change => console.log(`    - ${change}`))
  }
  if (result.warnings.length) {
    console.log()
    console.log('  Action needed:')
    result.warnings.forEach(warning => console.log(`    - ${warning}`))
  }
  console.log()
  console.log('  Next:')
  console.log('    opencode-gateway install     # Auto-start on boot')
  console.log('    opencode-gateway start       # Start the daemon')
  console.log('    opencode-gateway quickstart  # Guided first real task (recommended)')
  console.log('    Restart OpenCode if it was already running')
  console.log()
}

function describeSetupChanges(
  before: GatewayConfig,
  after: GatewayConfig,
  options: { hadConfig: boolean; configChanged: boolean; routingChanged: boolean; mode: SetupMode },
): string[] {
  if (!options.hadConfig) return ['created Gateway config from private-alpha defaults']
  const changes: string[] = []
  if (before.opencodeUrl !== after.opencodeUrl) changes.push(`OpenCode URL: ${before.opencodeUrl} -> ${after.opencodeUrl}`)
  if (before.httpPort !== after.httpPort) changes.push(`dashboard/service port: ${before.httpPort} -> ${after.httpPort}`)
  if ((before.opencodeConfigDir || '') !== (after.opencodeConfigDir || '')) changes.push('OpenCode config directory override changed')
  if (formatModelRef(before.profiles['planner']?.model) !== formatModelRef(after.profiles['planner']?.model)) changes.push('planner/coordinator model changed')
  if (formatModelRef(before.profiles['implementer']?.model) !== formatModelRef(after.profiles['implementer']?.model)) changes.push('implementer model changed')
  if (before.scheduler.maxConcurrent !== after.scheduler.maxConcurrent) changes.push(`max concurrent task stages: ${before.scheduler.maxConcurrent} -> ${after.scheduler.maxConcurrent}`)
  if (before.heartbeat.intervalMs !== after.heartbeat.intervalMs) changes.push(`heartbeat interval: ${before.heartbeat.intervalMs}ms -> ${after.heartbeat.intervalMs}ms`)
  if (secretChanged(before.channels.telegram.botToken, after.channels.telegram.botToken)) changes.push('Telegram token setting changed')
  if (secretChanged(before.channels.whatsapp.accessToken, after.channels.whatsapp.accessToken)) changes.push('WhatsApp access token setting changed')
  if (secretChanged(before.channels.whatsapp.verifyToken, after.channels.whatsapp.verifyToken)) changes.push('WhatsApp verify token setting changed')
  if (secretChanged(before.channels.whatsapp.appSecret, after.channels.whatsapp.appSecret)) changes.push('WhatsApp app secret setting changed')
  if (options.routingChanged) changes.push('created routing.json')
  if (!changes.length && options.mode === 'update') changes.push('configuration already up to date')
  else if (!changes.length && !options.configChanged) changes.push('configuration already up to date')
  return changes
}

function validatePrivateAlphaConfig(config: GatewayConfig, options: { hadConfig: boolean }): string[] {
  const warnings: string[] = []
  if (!options.hadConfig) warnings.push('Gateway config was missing; setup created it. Review config before exposing non-local services.')
  if (!config.opencodeUrl) warnings.push('OpenCode server URL is missing; run `opencode-gateway setup --wizard`.')
  if (!config.httpPort) warnings.push('Gateway dashboard/service port is missing; run `opencode-gateway setup --wizard`.')
  if (!config.profiles['planner']?.model?.providerID || !config.profiles['planner']?.model?.modelID) warnings.push('Planner model is missing; run `opencode-gateway setup --wizard`.')
  if (!config.profiles['implementer']?.model?.providerID || !config.profiles['implementer']?.model?.modelID) warnings.push('Implementer model is missing; run `opencode-gateway setup --wizard`.')
  return warnings
}

function checkSetupPrerequisites(): string[] {
  const nodeVersion = process.versions.node
  // Keep in sync with bin/preflight.mjs and package.json engines (>=22.13 <23 || >=23.4).
  if (!isSupportedNodeVersion(nodeVersion)) {
    throw new Error(`Node.js >=22.13 <23 || >=23.4 is required (current: v${nodeVersion}). Fix: install a supported Node build, e.g. \`nvm install 22.13 && nvm use 22.13\`, then re-run setup.`)
  }
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf-8' })
  if (npm.status !== 0) throw new Error('npm is required and was not found on PATH. Fix: install Node.js from nodejs.org (bundles npm) and ensure it is on your PATH.')
  try {
    const db = new DatabaseSync(':memory:')
    db.close()
  } catch (err: any) {
    throw new Error(`The built-in node:sqlite module is not loadable (${err?.message || err}). Fix: use a Node.js build with node:sqlite (>=22.5); reinstall Node from nodejs.org.`)
  }
  const configDir = getConfigDir()
  try {
    fs.mkdirSync(configDir, { recursive: true })
    const probe = path.join(configDir, `.setup-write-probe-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
  } catch (err: any) {
    throw new Error(`Config directory is not writable: ${configDir} (${err?.message || err}). Fix: \`mkdir -p "${configDir}" && chown -R "$(whoami)" "${configDir}"\`.`)
  }
  return [`Node.js v${nodeVersion} ok`, `npm ${npm.stdout.trim()} ok`, 'node:sqlite ok', 'config dir writable']
}

function loadCurrentConfig(mode: SetupMode): GatewayConfig {
  try {
    return getConfig()
  } catch (err: any) {
    throw new Error(`${mode} cannot continue because Gateway config is invalid: ${err?.message || err}`)
  }
}

function configComparable(config: GatewayConfig): string {
  return stableStringifyDefined(config)
}

function formatModelRef(model: GatewayConfig['profiles'][string]['model'] | undefined): string {
  return model?.providerID && model.modelID ? `${model.providerID}/${model.modelID}` : ''
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}

function normalizeOptionalSecret(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}

function parseInteger(value: string, label: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`)
  return number
}

function secretChanged(before: string | undefined, after: string | undefined): boolean {
  return before !== after
}


export function parseModelRef(value: string, label = 'Model'): readonly [string, string] {
  const [provider, ...modelParts] = value.split('/')
  const providerID = provider?.trim()
  const modelID = modelParts.join('/').trim()
  if (!providerID || !modelID) throw new Error(`${label} must be in provider/model format`)
  return [providerID, modelID]
}

if (process.argv[1]?.includes('cli-setup')) {
  runSetup().catch(err => { console.error('Setup failed:', err.message); process.exit(1) })
}
