export type ValidationGateSeverity = 'required' | 'advisory'
export type ValidationGateSelectionStatus = 'pass' | 'fail_closed'

export interface ValidationGateCommand {
  id: string
  command: string
  severity: ValidationGateSeverity
  reasons: string[]
  budgetMs?: number
  budgetKind?: 'warning_only'
}

export interface ValidationGateSurfaceMatch {
  id: string
  title: string
  files: string[]
  reason: string
  highRisk: boolean
}

export interface ValidationGateSelection {
  schemaVersion: 1
  mode: 'm58_validation_gate_selector'
  status: ValidationGateSelectionStatus
  changedFiles: string[]
  surfaces: ValidationGateSurfaceMatch[]
  commands: ValidationGateCommand[]
  performanceBudgets: ValidationGateCommand[]
  fullVerifyRequired: boolean
  failClosed: boolean
  reviewGateRequired: true
  warnings: string[]
  safeNextAction: string
}

export interface ValidationGateSelectorOptions {
  changedFiles: readonly string[]
}

const REQUIRED_REVIEW_GATE = 'local-only read-only autoreview/review-gate PASS'

const COMMANDS: Record<string, Omit<ValidationGateCommand, 'reasons'>> = {
  focused_channel_dashboard: {
    id: 'focused_channel_dashboard',
    command: 'npx vitest run src/__tests__/channel-commands.test.ts src/__tests__/telegram.test.ts src/__tests__/dashboard.test.ts src/__tests__/mission-control-view-model.test.ts --reporter=dot',
    severity: 'required',
    budgetMs: 180_000,
    budgetKind: 'warning_only',
  },
  focused_runtime: {
    id: 'focused_runtime',
    command: 'npx vitest run src/__tests__/scheduler.test.ts src/__tests__/work-store.test.ts src/__tests__/storage.test.ts src/__tests__/backend-cli.test.ts --reporter=dot',
    severity: 'required',
    budgetMs: 180_000,
    budgetKind: 'warning_only',
  },
  focused_validation_selector: {
    id: 'focused_validation_selector',
    command: 'npx vitest run src/__tests__/m58-validation-gate-selector.test.ts --reporter=dot',
    severity: 'required',
    budgetMs: 90_000,
    budgetKind: 'warning_only',
  },
  typecheck: {
    id: 'typecheck',
    command: 'npm run typecheck',
    severity: 'required',
    budgetMs: 90_000,
    budgetKind: 'warning_only',
  },
  validation_check: {
    id: 'validation_check',
    command: 'npm run validation:check',
    severity: 'required',
    budgetMs: 30_000,
    budgetKind: 'warning_only',
  },
  release_check: {
    id: 'release_check',
    command: 'npm run release:check',
    severity: 'required',
    budgetMs: 180_000,
    budgetKind: 'warning_only',
  },
  evidence_safety: {
    id: 'evidence_safety',
    command: 'npm run evidence:safety',
    severity: 'required',
    budgetMs: 90_000,
    budgetKind: 'warning_only',
  },
  docs_strict: {
    id: 'docs_strict',
    command: 'uv run --with-requirements docs/requirements.txt mkdocs build --strict',
    severity: 'required',
    budgetMs: 120_000,
    budgetKind: 'warning_only',
  },
  module_boundaries: {
    id: 'module_boundaries',
    command: 'node scripts/check-module-boundaries.mjs --json',
    severity: 'required',
    budgetMs: 30_000,
    budgetKind: 'warning_only',
  },
  full_verify: {
    id: 'full_verify',
    command: 'npm run verify',
    severity: 'required',
    budgetMs: 900_000,
    budgetKind: 'warning_only',
  },
  review_gate: {
    id: 'review_gate',
    command: REQUIRED_REVIEW_GATE,
    severity: 'required',
    budgetMs: 300_000,
    budgetKind: 'warning_only',
  },
}

interface ValidationSurfaceRule {
  id: string
  title: string
  reason: string
  highRisk: boolean
  patterns: RegExp[]
  commandIds: string[]
  requiresFullVerify?: boolean
  failClosed?: boolean
}

const SURFACE_RULES: readonly ValidationSurfaceRule[] = [
  {
    id: 'docs',
    title: 'Docs, navigation, and operator wording',
    reason: 'Documentation or navigation changed; strict docs and claim/redaction checks are required.',
    highRisk: false,
    patterns: [/^README\.md$/, /^mkdocs\.yml$/, /^docs\/.+\.(?:md|yml|yaml)$/],
    commandIds: ['docs_strict', 'evidence_safety', 'release_check'],
  },
  {
    id: 'generated_evidence',
    title: 'Generated evidence artifacts',
    reason: 'Machine-readable evidence changed; release and evidence-safety gates must re-read it.',
    highRisk: false,
    patterns: [/^docs\/operations\/.+(?:evidence|summary)\.json$/],
    commandIds: ['evidence_safety', 'release_check', 'validation_check'],
  },
  {
    id: 'release_evidence_source',
    title: 'Release evidence source modules',
    reason: 'Evidence/report source changed; typecheck, focused selector/evidence tests, release gates, and boundaries are required.',
    highRisk: false,
    patterns: [
      /^src\/m\d+-.+\.ts$/,
      /^src\/evidence-[^/]+\.ts$/,
      /^src\/validation-gate-selector(?:-cli)?\.ts$/,
    ],
    commandIds: ['focused_validation_selector', 'typecheck', 'validation_check', 'evidence_safety', 'release_check', 'module_boundaries'],
  },
  {
    id: 'validation_infrastructure',
    title: 'Validation infrastructure',
    reason: 'Validation infrastructure changed; full verify is mandatory because gate selection itself is shared process infrastructure.',
    highRisk: true,
    patterns: [
      /^scripts\/(?:check-validation-gates|run-verify|check-release|check-evidence-safety|check-module-boundaries)\.mjs$/,
      /^docs\/development\/(?:validation-gates|testing-release|agent-handoff-template|module-boundary-budget)\.(?:json|md)$/,
      /^package(?:-lock)?\.json$/,
      /^\.github\/workflows\/.+\.yml$/,
    ],
    commandIds: ['focused_validation_selector', 'typecheck', 'validation_check', 'evidence_safety', 'release_check', 'module_boundaries', 'full_verify'],
    requiresFullVerify: true,
  },
  {
    id: 'runtime_shared',
    title: 'Shared runtime behavior',
    reason: 'Runtime source changed; focused runtime gates are useful but full verify remains mandatory.',
    highRisk: true,
    patterns: [
      /^src\/(?:scheduler|storage|work-store|orchestration|orchestration-kernel|daemon|daemon-router|security|security-policy|runtime-|capacity|quota|environments)\b.*\.ts$/,
      /^src\/work-store\/.+\.ts$/,
      /^src\/daemon-routes\/.+\.ts$/,
    ],
    commandIds: ['focused_runtime', 'typecheck', 'module_boundaries', 'release_check', 'full_verify'],
    requiresFullVerify: true,
  },
  {
    id: 'channel_dashboard',
    title: 'Channel, dashboard, and Mission Control behavior',
    reason: 'Channel or operator UI behavior changed; focused surface tests plus full verify are required.',
    highRisk: true,
    patterns: [
      /^src\/(?:channel|channel-actions|channel-commands|channel-connectors|channel-sessions|channel-sync)\b.*\.ts$/,
      /^src\/channels\/.+\.ts$/,
      /^src\/(?:dashboard|mission-control-view-model|mission-data|mcp)\.ts$/,
    ],
    commandIds: ['focused_channel_dashboard', 'typecheck', 'evidence_safety', 'release_check', 'module_boundaries', 'full_verify'],
    requiresFullVerify: true,
  },
  {
    id: 'tests',
    title: 'Tests and fixtures',
    reason: 'Tests changed; run the focused touched tests and full verify when shared fixtures or validation infrastructure are involved.',
    highRisk: false,
    patterns: [/^src\/__tests__\/.+\.test\.ts$/, /^src\/testing\/.+\.ts$/],
    commandIds: ['typecheck'],
  },
]

const UNKNOWN_RULE: ValidationSurfaceRule = {
  id: 'unknown',
  title: 'Unknown or unclassified paths',
  reason: 'At least one path is not covered by the validation graph; selector fails closed to the broad gates.',
  highRisk: true,
  patterns: [],
  commandIds: ['typecheck', 'validation_check', 'evidence_safety', 'release_check', 'full_verify'],
  requiresFullVerify: true,
  failClosed: true,
}

export function normalizeChangedFile(file: string): string {
  return file.trim().replace(/^\.\//, '')
}

export function selectValidationGates(options: ValidationGateSelectorOptions): ValidationGateSelection {
  const changedFiles = [...new Set(options.changedFiles.map(normalizeChangedFile).filter(Boolean))].sort()
  const surfaces: ValidationGateSurfaceMatch[] = []
  const commandReasons = new Map<string, string[]>()
  const warnings: string[] = []
  let fullVerifyRequired = false
  let failClosed = false

  for (const file of changedFiles) {
    const matchedRules = SURFACE_RULES.filter(rule => rule.patterns.some(pattern => pattern.test(file)))
    const rules = matchedRules.length > 0 ? matchedRules : [UNKNOWN_RULE]
    if (matchedRules.length === 0) {
      failClosed = true
      warnings.push(`Unknown path ${file} mapped to conservative gates.`)
    }
    for (const rule of rules) {
      if (rule.requiresFullVerify) fullVerifyRequired = true
      if (rule.failClosed) failClosed = true
      addSurfaceMatch(surfaces, rule, file)
      for (const commandId of rule.commandIds) {
        addCommandReason(commandReasons, commandId, `${file}: ${rule.reason}`)
      }
    }
  }

  addCommandReason(commandReasons, 'review_gate', 'Hard gate for every final diff before PR review or merge.')
  if (changedFiles.length === 0) {
    warnings.push('No changed files detected; run with --base or --files if validating a committed diff.')
  }

  const commands = [...commandReasons.entries()]
    .map(([id, reasons]) => {
      const command = COMMANDS[id]
      if (!command) return undefined
      return {
        ...command,
        reasons: [...new Set(reasons)].sort(),
      }
    })
    .filter((command): command is ValidationGateCommand => Boolean(command))
    .sort((a, b) => commandOrder(a.id) - commandOrder(b.id) || a.id.localeCompare(b.id))

  const performanceBudgets = commands.filter(command => typeof command.budgetMs === 'number')
  if (performanceBudgets.length > 0) {
    warnings.push('Performance budgets are warning-only; a slow command still fails only when the command itself fails or a required gate is missing.')
  }

  return {
    schemaVersion: 1,
    mode: 'm58_validation_gate_selector',
    status: failClosed ? 'fail_closed' : 'pass',
    changedFiles,
    surfaces: surfaces.sort((a, b) => a.id.localeCompare(b.id)),
    commands,
    performanceBudgets,
    fullVerifyRequired,
    failClosed,
    reviewGateRequired: true,
    warnings: [...new Set(warnings)].sort(),
    safeNextAction: failClosed
      ? 'Run the conservative command set, then extend the validation graph with an owner-specific rule if this path should be classified.'
      : fullVerifyRequired
        ? 'Run focused gates first, then npm run verify and the local-only read-only review gate before PR review or merge.'
        : 'Run the selected focused gates and the local-only read-only review gate; escalate to npm run verify if shared behavior changed.',
  }
}

export function formatValidationGateSelection(selection: ValidationGateSelection): string {
  const lines = [
    `Validation gate selector: ${selection.status}`,
    `Changed files: ${selection.changedFiles.length || 0}`,
    '',
    'Surfaces:',
    ...selection.surfaces.map(surface => `- ${surface.id}: ${surface.files.join(', ')}`),
    '',
    'Required commands:',
    ...selection.commands.map(command => `- ${command.command}`),
    '',
    'Performance budgets (warning-only):',
    ...selection.performanceBudgets.map(command => `- ${command.id}: ${command.budgetMs}ms`),
    '',
    `Safe next action: ${selection.safeNextAction}`,
  ]
  if (selection.warnings.length > 0) {
    lines.push('', 'Warnings:', ...selection.warnings.map(warning => `- ${warning}`))
  }
  return `${lines.join('\n')}\n`
}

function addSurfaceMatch(surfaces: ValidationGateSurfaceMatch[], rule: ValidationSurfaceRule, file: string): void {
  const existing = surfaces.find(surface => surface.id === rule.id)
  if (existing) {
    existing.files = [...new Set([...existing.files, file])].sort()
    return
  }
  surfaces.push({
    id: rule.id,
    title: rule.title,
    files: [file],
    reason: rule.reason,
    highRisk: rule.highRisk,
  })
}

function addCommandReason(commandReasons: Map<string, string[]>, id: string, reason: string): void {
  const existing = commandReasons.get(id) ?? []
  existing.push(reason)
  commandReasons.set(id, existing)
}

function commandOrder(id: string): number {
  return [
    'focused_validation_selector',
    'focused_channel_dashboard',
    'focused_runtime',
    'typecheck',
    'validation_check',
    'module_boundaries',
    'docs_strict',
    'evidence_safety',
    'release_check',
    'full_verify',
    'review_gate',
  ].indexOf(id)
}
