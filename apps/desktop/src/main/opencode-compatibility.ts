import type { RuntimeCompatibilityAssumption, RuntimeCompatibilityReport } from '@open-cowork/shared'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { getBundledOpencodeVersion } from './runtime-opencode-cli.ts'

const QUALIFIED_OPENCODE_VERSION = 'bundled'
const REQUIRED_COMPATIBILITY_CATEGORIES = ['sdk-import', 'config', 'event', 'permission', 'plugin'] as const
const VALID_COMPATIBILITY_STATUSES = new Set(['supported', 'shim', 'private-assumption', 'blocked', 'unknown'])

export interface OpencodeCompatibilityCheckOptions {
  allowMissingRuntimeVersion?: boolean
  allowPrivateAssumptions?: boolean
  repositoryRoot?: string
  runtimeContractFixture?: OpencodeRuntimeContractFixture | null
}

export interface OpencodeCompatibilityCheckIssue {
  assumptionId?: string
  code: string
  message: string
  severity: 'error' | 'warning'
}

export interface OpencodeCompatibilityCheckResult {
  ok: boolean
  opencodeVersion: string | null
  assumptionCount: number
  runtimeContractCount: number
  blockedCount: number
  shimCount: number
  privateAssumptionCount: number
  unknownCount: number
  checkedCategories: string[]
  issues: OpencodeCompatibilityCheckIssue[]
}

export interface OpencodeRuntimeContractProof {
  id: string
  owner: string
  tests: string[]
}

export interface OpencodeRuntimeConfigContract extends OpencodeRuntimeContractProof {
  key: string
  evidence: string
}

export interface OpencodeRuntimeEventContract extends OpencodeRuntimeContractProof {
  fixturePath: string
  events: string[]
}

export interface OpencodeRuntimeHttpRouteContract extends OpencodeRuntimeContractProof {
  method: string
  path: string
}

export interface OpencodeRuntimeClientMethodContract extends OpencodeRuntimeContractProof {
  method: string
  evidence: string
}

export interface OpencodeRuntimeContractFixture {
  formatVersion: 1
  opencodeVersion: string
  requiredAssumptionIds: string[]
  runtimeConfig: OpencodeRuntimeConfigContract[]
  sdkEvents: OpencodeRuntimeEventContract[]
  httpRoutes: OpencodeRuntimeHttpRouteContract[]
  clientMethods: OpencodeRuntimeClientMethodContract[]
}

export const OPENCODE_COMPATIBILITY_REGISTRY = [
  {
    id: 'opencode-sdk-v2-import-boundary',
    category: 'sdk-import',
    status: 'supported',
    owner: 'desktop-runtime',
    sourceVersion: QUALIFIED_OPENCODE_VERSION,
    reason: 'OpenCode SDK imports are limited to documented runtime-boundary modules.',
    tests: ['tests/opencode-sdk-boundary.test.ts'],
    productModes: ['desktop-local', 'desktop-cloud', 'cloud-web', 'cloud-channel-gateway', 'standalone-gateway'],
  },
  {
    id: 'runtime-config-builder-sdk-native-config',
    category: 'config',
    status: 'supported',
    owner: 'desktop-runtime',
    sourceVersion: QUALIFIED_OPENCODE_VERSION,
    reason: 'Providers, models, MCPs, skills, agents, and permissions are emitted through the SDK-typed runtime config builder.',
    tests: ['tests/runtime-config-builder.test.ts', 'tests/runtime-input-diagnostics.test.ts'],
    productModes: ['desktop-local', 'desktop-cloud'],
  },
  {
    id: 'cloud-session-event-projection-contract',
    category: 'event',
    status: 'supported',
    owner: 'cloud-projection',
    sourceVersion: QUALIFIED_OPENCODE_VERSION,
    reason: 'Raw OpenCode events are normalized into the shared projection contract before renderer, Cloud, or Gateway consumers see them.',
    tests: ['tests/opencode-sdk-event-projection.test.ts', 'tests/cloud-session-projection-contract.test.ts'],
    productModes: ['desktop-cloud', 'cloud-web', 'cloud-channel-gateway'],
  },
  {
    id: 'permission-question-roundtrip-contract',
    category: 'permission',
    status: 'supported',
    owner: 'desktop-runtime',
    sourceVersion: QUALIFIED_OPENCODE_VERSION,
    reason: 'Permission and question payloads stay OpenCode-native at execution while Open Cowork projects user-facing approval/question state.',
    tests: ['tests/permission-config.test.ts', 'tests/question-normalization.test.ts', 'tests/event-runtime-handlers.test.ts'],
    productModes: ['desktop-local', 'desktop-cloud', 'paired-desktop'],
  },
  {
    id: 'opencode-plugin-remote-fail-closed',
    category: 'plugin',
    status: 'blocked',
    owner: 'capabilities',
    sourceVersion: QUALIFIED_OPENCODE_VERSION,
    reason: 'OpenCode plugin behavior is blocked for remote/cloud modes unless a capability bundle declares a supported compatibility tier.',
    tests: ['tests/capability-bundle-policy.test.ts'],
    removalCondition: 'Replace with supported plugin capability only after product-mode policy, audit, uninstall, and permission tests exist.',
    productModes: ['desktop-cloud', 'cloud-web', 'cloud-channel-gateway', 'paired-desktop', 'headless-host'],
  },
] as const satisfies readonly RuntimeCompatibilityAssumption[]

export function getOpencodeCompatibilityRegistry(): RuntimeCompatibilityAssumption[] {
  return OPENCODE_COMPATIBILITY_REGISTRY.map((entry) => ({ ...entry, tests: [...entry.tests], productModes: entry.productModes ? [...entry.productModes] : undefined }))
}

export function getOpencodeCompatibilityReport(): RuntimeCompatibilityReport {
  const opencodeVersion = getBundledOpencodeVersion()
  return {
    opencodeVersion,
    assumptions: getOpencodeCompatibilityRegistry().map((entry) => ({
      ...entry,
      sourceVersion: entry.sourceVersion === QUALIFIED_OPENCODE_VERSION ? (opencodeVersion || QUALIFIED_OPENCODE_VERSION) : entry.sourceVersion,
    })),
  }
}

export function checkOpencodeCompatibilityReport(
  report: RuntimeCompatibilityReport,
  options: OpencodeCompatibilityCheckOptions = {},
): OpencodeCompatibilityCheckResult {
  const repositoryRoot = options.repositoryRoot || process.cwd()
  const issues: OpencodeCompatibilityCheckIssue[] = []
  const ids = new Set<string>()
  const categories = new Set<string>()

  if (!report.opencodeVersion && !options.allowMissingRuntimeVersion) {
    issues.push({
      code: 'opencode_version_missing',
      severity: 'error',
      message: 'Bundled OpenCode version could not be resolved.',
    })
  }

  for (const assumption of report.assumptions) {
    categories.add(assumption.category)
    checkAssumptionShape(assumption, report, repositoryRoot, ids, options, issues)
  }

  for (const category of REQUIRED_COMPATIBILITY_CATEGORIES) {
    if (!categories.has(category)) {
      issues.push({
        code: 'compatibility_category_missing',
        severity: 'error',
        message: `OpenCode compatibility registry must include a ${category} assumption.`,
      })
    }
  }

  if (report.assumptions.length === 0) {
    issues.push({
      code: 'compatibility_registry_empty',
      severity: 'error',
      message: 'OpenCode compatibility registry must not be empty.',
    })
  }

  const runtimeContractCount = options.runtimeContractFixture
    ? checkRuntimeContractFixture(options.runtimeContractFixture, report, repositoryRoot, issues)
    : 0

  const blockedCount = report.assumptions.filter((assumption) => assumption.status === 'blocked').length
  const shimCount = report.assumptions.filter((assumption) => assumption.status === 'shim').length
  const privateAssumptionCount = report.assumptions.filter((assumption) => assumption.status === 'private-assumption').length
  const unknownCount = report.assumptions.filter((assumption) => assumption.status === 'unknown').length

  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    opencodeVersion: report.opencodeVersion,
    assumptionCount: report.assumptions.length,
    runtimeContractCount,
    blockedCount,
    shimCount,
    privateAssumptionCount,
    unknownCount,
    checkedCategories: Array.from(categories).sort(),
    issues,
  }
}

function checkRuntimeContractFixture(
  fixture: OpencodeRuntimeContractFixture,
  report: RuntimeCompatibilityReport,
  repositoryRoot: string,
  issues: OpencodeCompatibilityCheckIssue[],
) {
  const reportAssumptionIds = new Set(report.assumptions.map((assumption) => assumption.id))
  const fixtureAssumptionIds = new Set(fixture.requiredAssumptionIds)
  const contractEntries = [
    ...fixture.runtimeConfig,
    ...fixture.sdkEvents,
    ...fixture.httpRoutes,
    ...fixture.clientMethods,
  ]
  const contractIds = new Set<string>()
  const addError = (code: string, message: string, assumptionId?: string) => {
    issues.push({ assumptionId, code, severity: 'error', message })
  }

  if (fixture.formatVersion !== 1) {
    addError('runtime_contract_format_invalid', 'OpenCode runtime contract fixture must use formatVersion 1.')
  }
  if (report.opencodeVersion && fixture.opencodeVersion !== report.opencodeVersion) {
    addError(
      'runtime_contract_version_drift',
      `OpenCode runtime contract fixture ${fixture.opencodeVersion} does not match bundled OpenCode ${report.opencodeVersion}.`,
    )
  }

  for (const assumptionId of reportAssumptionIds) {
    if (!fixtureAssumptionIds.has(assumptionId)) {
      addError('runtime_contract_assumption_missing', `Runtime contract fixture is missing assumption ${assumptionId}.`, assumptionId)
    }
  }
  for (const assumptionId of fixtureAssumptionIds) {
    if (!reportAssumptionIds.has(assumptionId)) {
      addError('runtime_contract_assumption_unknown', `Runtime contract fixture references unknown assumption ${assumptionId}.`, assumptionId)
    }
  }

  for (const [section, entries] of [
    ['runtimeConfig', fixture.runtimeConfig],
    ['sdkEvents', fixture.sdkEvents],
    ['httpRoutes', fixture.httpRoutes],
    ['clientMethods', fixture.clientMethods],
  ] as const) {
    if (entries.length === 0) {
      addError('runtime_contract_section_empty', `OpenCode runtime contract fixture section ${section} must not be empty.`)
    }
  }

  for (const entry of contractEntries) {
    checkRuntimeContractProof(entry, repositoryRoot, contractIds, issues)
  }

  for (const entry of fixture.runtimeConfig) {
    if (!entry.key.trim() || !entry.evidence.trim()) {
      addError('runtime_contract_config_key_invalid', `Runtime config contract ${entry.id} must name a config key and evidence.`, entry.id)
    }
  }
  for (const entry of fixture.httpRoutes) {
    if (!/^(GET|POST|PATCH|PUT|DELETE)$/u.test(entry.method) || !entry.path.startsWith('/')) {
      addError('runtime_contract_route_invalid', `Runtime route contract ${entry.id} must use an HTTP method and absolute path.`, entry.id)
    }
  }
  for (const entry of fixture.clientMethods) {
    if (!entry.method.trim() || !entry.evidence.trim()) {
      addError('runtime_contract_client_method_invalid', `Runtime client method contract ${entry.id} must name a method and evidence.`, entry.id)
    }
  }
  for (const entry of fixture.sdkEvents) {
    checkEventFixtureEntry(entry, repositoryRoot, issues)
  }

  return contractEntries.length
}

function checkRuntimeContractProof(
  entry: OpencodeRuntimeContractProof,
  repositoryRoot: string,
  ids: Set<string>,
  issues: OpencodeCompatibilityCheckIssue[],
) {
  const addError = (code: string, message: string) => {
    issues.push({ assumptionId: entry.id, code, severity: 'error', message })
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
    addError('runtime_contract_id_invalid', 'OpenCode runtime contract ids must be stable kebab-case identifiers.')
  }
  if (ids.has(entry.id)) addError('runtime_contract_id_duplicate', `Duplicate OpenCode runtime contract id ${entry.id}.`)
  ids.add(entry.id)
  if (!entry.owner.trim()) addError('runtime_contract_owner_missing', 'OpenCode runtime contract entries must name an owner.')
  if (!entry.tests.length) addError('runtime_contract_tests_missing', 'OpenCode runtime contract entries must list proving tests.')
  for (const testPath of entry.tests) {
    checkRepositoryFile(testPath, repositoryRoot, 'runtime_contract_test_path_invalid', 'runtime_contract_test_missing', entry.id, issues)
  }
}

function checkEventFixtureEntry(
  entry: OpencodeRuntimeEventContract,
  repositoryRoot: string,
  issues: OpencodeCompatibilityCheckIssue[],
) {
  const resolvedFixturePath = checkRepositoryFile(
    entry.fixturePath,
    repositoryRoot,
    'runtime_contract_event_fixture_path_invalid',
    'runtime_contract_event_fixture_missing',
    entry.id,
    issues,
  )
  if (!resolvedFixturePath) return
  let fixture: { sdkEvents?: Array<{ name?: unknown }> }
  try {
    fixture = JSON.parse(readFileSync(resolvedFixturePath, 'utf8')) as { sdkEvents?: Array<{ name?: unknown }> }
  } catch {
    issues.push({
      assumptionId: entry.id,
      code: 'runtime_contract_event_fixture_parse_failed',
      severity: 'error',
      message: `OpenCode SDK event fixture ${entry.fixturePath} could not be parsed.`,
    })
    return
  }
  const fixtureEventNames = new Set((fixture.sdkEvents || []).map((event) => event.name).filter((name): name is string => typeof name === 'string'))
  for (const eventName of entry.events) {
    if (!fixtureEventNames.has(eventName)) {
      issues.push({
        assumptionId: entry.id,
        code: 'runtime_contract_event_missing',
        severity: 'error',
        message: `OpenCode SDK event fixture ${entry.fixturePath} is missing event ${eventName}.`,
      })
    }
  }
}

function checkRepositoryFile(
  filePath: string,
  repositoryRoot: string,
  invalidCode: string,
  missingCode: string,
  assumptionId: string,
  issues: OpencodeCompatibilityCheckIssue[],
) {
  const resolvedPath = resolve(repositoryRoot, filePath)
  const relativePath = relative(repositoryRoot, resolvedPath)
  if (relativePath === '' || relativePath.startsWith('..') || relativePath.startsWith('/')) {
    issues.push({
      assumptionId,
      code: invalidCode,
      severity: 'error',
      message: `OpenCode compatibility path ${filePath} must stay inside the repository.`,
    })
    return null
  }
  if (!existsSync(resolvedPath)) {
    issues.push({
      assumptionId,
      code: missingCode,
      severity: 'error',
      message: `OpenCode compatibility file ${filePath} does not exist.`,
    })
    return null
  }
  return resolvedPath
}

function checkAssumptionShape(
  assumption: RuntimeCompatibilityAssumption,
  report: RuntimeCompatibilityReport,
  repositoryRoot: string,
  ids: Set<string>,
  options: OpencodeCompatibilityCheckOptions,
  issues: OpencodeCompatibilityCheckIssue[],
) {
  const addError = (code: string, message: string) => {
    issues.push({ assumptionId: assumption.id, code, severity: 'error', message })
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(assumption.id)) {
    addError('compatibility_id_invalid', 'Compatibility assumption ids must be stable kebab-case identifiers.')
  }
  if (ids.has(assumption.id)) addError('compatibility_id_duplicate', `Duplicate compatibility assumption id ${assumption.id}.`)
  ids.add(assumption.id)

  if (!VALID_COMPATIBILITY_STATUSES.has(assumption.status)) {
    addError('compatibility_status_invalid', `Unsupported compatibility status ${assumption.status}.`)
  }
  if (assumption.status === 'unknown') {
    addError('compatibility_unknown_blocked', 'Unknown OpenCode compatibility assumptions must be resolved before release.')
  }
  if (assumption.status === 'private-assumption' && !options.allowPrivateAssumptions) {
    addError('compatibility_private_assumption_blocked', 'Private OpenCode assumptions are not release-safe without an explicit override.')
  }
  if ((assumption.status === 'shim' || assumption.status === 'blocked') && !assumption.removalCondition?.trim()) {
    addError('compatibility_removal_condition_missing', `${assumption.status} compatibility entries must declare a removal condition.`)
  }
  if (!assumption.owner.trim()) addError('compatibility_owner_missing', 'Compatibility assumptions must name an owner.')
  if (!assumption.reason.trim()) addError('compatibility_reason_missing', 'Compatibility assumptions must explain why they are safe.')
  if (!assumption.productModes?.length) addError('compatibility_product_modes_missing', 'Compatibility assumptions must name affected product modes.')
  if (!assumption.tests.length) addError('compatibility_tests_missing', 'Compatibility assumptions must list proving tests.')

  for (const testPath of assumption.tests) {
    const resolvedTestPath = resolve(repositoryRoot, testPath)
    const relativeTestPath = relative(repositoryRoot, resolvedTestPath)
    if (relativeTestPath === '' || relativeTestPath.startsWith('..') || relativeTestPath.startsWith('/')) {
      addError('compatibility_test_path_invalid', `Compatibility test path ${testPath} must stay inside the repository.`)
      continue
    }
    if (!existsSync(resolvedTestPath)) {
      addError('compatibility_test_missing', `Compatibility test ${testPath} does not exist.`)
    }
  }

  if (report.opencodeVersion && assumption.sourceVersion !== report.opencodeVersion) {
    addError(
      'compatibility_source_version_drift',
      `Compatibility assumption source version ${assumption.sourceVersion} does not match bundled OpenCode ${report.opencodeVersion}.`,
    )
  }
}
