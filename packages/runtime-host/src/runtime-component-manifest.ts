import { sanitizeForExport } from '@open-cowork/shared'
import { getAppPathHost } from '@open-cowork/shared/node'
import type {
  RuntimeComponentManifest,
  RuntimeComponentManifestEntry,
  RuntimeComponentVerificationIssue,
  RuntimeComponentVerificationReport,
} from '@open-cowork/shared'
import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  getBundledOpencodeSdkVersion,
  getBundledOpencodeVersion,
  readBundledOpencodeCliVersion,
  resolveBundledOpencodeBinaryPath,
  resolveBundledOpencodePackageJsonPath,
  resolveBundledOpencodeSdkPackageJsonPath,
  resolveBundledOpencodeWrapperPath,
} from './runtime-opencode-cli.js'
import { resolveBundledMcpScriptPath } from './runtime-mcp.js'
import { recordRuntimeComponentVerification } from './runtime-status.js'

const RUNTIME_COMPONENT_MANIFEST_FORMAT = 'open-cowork-runtime-component-manifest-v1' satisfies RuntimeComponentVerificationReport['format']
const RUNTIME_COMPONENT_MANIFEST_FILE = 'runtime-components.manifest.json'

type RuntimeComponentId =
  | 'opencode-cli'
  | 'opencode-sdk'
  | 'agent-tool-mcp'
  | 'workflow-mcp'
  | 'semantic-ui-mcp'

export interface RuntimeComponentDevelopmentOverride {
  enabled: boolean
  reason?: string
}

export interface RuntimeComponentManifestLoadIssue {
  code: 'component_manifest_missing' | 'component_manifest_parse_failed'
  message: string
}

export interface RuntimeComponentVerificationInput {
  manifest?: RuntimeComponentManifest | null
  observedManifest?: RuntimeComponentManifest | null
  manifestLoadIssue?: RuntimeComponentManifestLoadIssue | null
  developmentOverride?: RuntimeComponentDevelopmentOverride
  now?: () => Date
}

export interface RuntimeComponentManifestBuildInput {
  bundledOpencodeEnv?: {
    opencodeBinPath?: string | null
    path?: string | null
  }
  componentPaths?: Partial<Record<RuntimeComponentId, string | null>>
  componentVersions?: Partial<Record<RuntimeComponentId, string | null>>
  developmentOverride?: RuntimeComponentDevelopmentOverride
  env?: Record<string, string | undefined>
  generatedAt?: string
  isPackaged?: boolean
  manifest?: RuntimeComponentManifest | null
  manifestPath?: string | null
  now?: () => Date
  resourcesPath?: string
}

const managedMcpComponents: Array<{
  id: RuntimeComponentId
  kind: RuntimeComponentManifestEntry['kind']
  packageName: string
  capabilities: string[]
}> = [
  {
    id: 'agent-tool-mcp',
    kind: 'agent-tool-mcp',
    packageName: 'agents',
    capabilities: ['agents', 'subagents', 'delegation'],
  },
  {
    id: 'workflow-mcp',
    kind: 'workflow-mcp',
    packageName: 'workflows',
    capabilities: ['workflows', 'runs', 'control-plane'],
  },
  {
    id: 'semantic-ui-mcp',
    kind: 'semantic-ui-mcp',
    packageName: 'semantic-ui',
    capabilities: ['semantic-ui', 'actions', 'status'],
  },
]

const COMPONENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const COMPONENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/

function validSha256(value: string) {
  return /^(sha256:)?[a-f0-9]{64}$/i.test(value)
}

function normalizedSha256(value: string) {
  return value.replace(/^sha256:/i, '').toLowerCase()
}

function validComponentIdentity(entry: RuntimeComponentManifestEntry) {
  return COMPONENT_ID_PATTERN.test(entry.id)
    && COMPONENT_VERSION_PATTERN.test(entry.version)
}

function hasComponentSource(entry: RuntimeComponentManifestEntry) {
  return Boolean(entry.path?.trim() || entry.url?.trim())
}

function componentHasReleaseEvidence(entry: RuntimeComponentManifestEntry) {
  return Boolean(
    (entry.sha256 && validSha256(entry.sha256))
      || entry.signature?.trim(),
  )
}

function developmentOverrideAllowed(input: RuntimeComponentVerificationInput) {
  return input.developmentOverride?.enabled === true
    && Boolean(input.developmentOverride.reason?.trim())
}

function isPackaged(input: Pick<RuntimeComponentManifestBuildInput, 'isPackaged'> = {}) {
  return input.isPackaged ?? Boolean(getAppPathHost()?.isPackaged)
}

const SEMVER_PATTERN = /\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?/y

// Extract the leftmost `major.minor.patch[-+prerelease]` substring.
// An unanchored `String.match` with this pattern re-scans digit runs at every
// offset and degrades to quadratic time on adversarial input (polynomial
// ReDoS). Using a sticky match attempted only at the start of each digit run —
// where the leftmost match must begin — keeps the scan linear while returning
// the exact same substring an unanchored match would.
function extractSemver(value: string): string | undefined {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 48 || code > 57) continue
    const prev = i > 0 ? value.charCodeAt(i - 1) : 0
    if (prev >= 48 && prev <= 57) continue
    SEMVER_PATTERN.lastIndex = i
    const match = SEMVER_PATTERN.exec(value)
    if (match) return match[0]
  }
  return undefined
}

function normalizeComponentVersion(value: string | null | undefined) {
  const trimmed = value?.trim()
  if (!trimmed) return 'unknown'
  const semver = extractSemver(trimmed)
  const normalized = semver || trimmed.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._:+/-]/g, '_')
  return normalized.slice(0, 128) || 'unknown'
}

function hashFileSha256(path: string | null | undefined) {
  if (!path) return undefined
  let fd: number | null = null
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
    fd = openSync(path, fsConstants.O_RDONLY | noFollow)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return undefined
    return createHash('sha256').update(readFileSync(fd)).digest('hex')
  } catch {
    return undefined
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function readJsonFile(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function readPackageVersion(path: string | null | undefined) {
  if (!path) return null
  try {
    const data = readJsonFile(path) as { version?: unknown }
    return typeof data.version === 'string' && data.version.length > 0 ? data.version : null
  } catch {
    return null
  }
}

function repoResourcePath(input: Pick<RuntimeComponentManifestBuildInput, 'resourcesPath'>, ...segments: string[]) {
  if (getAppPathHost()?.isPackaged) return join(input.resourcesPath || ((process as { resourcesPath?: string }).resourcesPath ?? process.cwd()), ...segments)
  return resolve(process.cwd(), ...segments)
}

function resolveMcpPackageJsonPath(packageName: string, input: Pick<RuntimeComponentManifestBuildInput, 'resourcesPath'> = {}) {
  const candidate = repoResourcePath(input, 'mcps', packageName, 'package.json')
  return existsSync(candidate) ? candidate : null
}

function resolveMcpComponentPath(
  id: RuntimeComponentId,
  packageName: string,
  input: RuntimeComponentManifestBuildInput,
) {
  const override = input.componentPaths?.[id]
  if (override !== undefined) return override || undefined

  const scriptPath = resolveBundledMcpScriptPath(packageName)
  if (existsSync(scriptPath)) return scriptPath

  const sourcePath = repoResourcePath(input, 'mcps', packageName, 'src', 'index.ts')
  if (existsSync(sourcePath)) return sourcePath

  return resolveMcpPackageJsonPath(packageName, input) || scriptPath
}

function runtimeComponent(
  input: RuntimeComponentManifestBuildInput,
  entry: Omit<RuntimeComponentManifestEntry, 'version' | 'sourcePolicy' | 'compatibilityStatus'> & {
    compatibilityStatus?: RuntimeComponentManifestEntry['compatibilityStatus']
    sourcePolicy?: RuntimeComponentManifestEntry['sourcePolicy']
    version?: string | null
  },
): RuntimeComponentManifestEntry {
  const path = entry.path?.trim() || undefined
  const observedSha256 = hashFileSha256(path)
  return {
    ...entry,
    version: normalizeComponentVersion(entry.version),
    observedVersion: normalizeComponentVersion(entry.version),
    path,
    observedSha256,
    sourcePolicy: entry.sourcePolicy || (isPackaged(input) ? 'bundled' : 'development'),
    compatibilityStatus: entry.compatibilityStatus || 'supported',
  }
}

function mergeObservedComponentEvidence(
  expected: RuntimeComponentManifest,
  observed: RuntimeComponentManifest,
): RuntimeComponentManifest {
  const observedById = new Map(observed.components.map((entry) => [entry.id, entry]))
  return {
    ...expected,
    components: expected.components.map((entry) => {
      const observedEntry = observedById.get(entry.id)
      if (!observedEntry) return entry
      return {
        ...entry,
        observedVersion: observedEntry.version,
        platform: entry.platform || observedEntry.platform,
        arch: entry.arch || observedEntry.arch,
        path: entry.path || observedEntry.path,
        observedSha256: observedEntry.observedSha256,
      }
    }),
  }
}

function manifestLoadIssueForPath(path: string): RuntimeComponentManifestLoadIssue {
  return {
    code: 'component_manifest_missing',
    message: `Runtime component manifest was not found at ${path}.`,
  }
}

function issue(
  code: RuntimeComponentVerificationIssue['code'],
  message: string,
  options: {
    componentId?: string
    severity?: RuntimeComponentVerificationIssue['severity']
  } = {},
): RuntimeComponentVerificationIssue {
  return {
    code,
    severity: options.severity || 'error',
    ...(options.componentId ? { componentId: sanitizeForExport(options.componentId) } : {}),
    message: sanitizeForExport(message),
  }
}

function redactedComponent(entry: RuntimeComponentManifestEntry): RuntimeComponentManifestEntry {
  return {
    ...entry,
    path: entry.path ? sanitizeForExport(entry.path) : undefined,
    url: entry.url ? sanitizeForExport(entry.url) : undefined,
    signature: entry.signature ? '[redacted-signature]' : undefined,
  }
}

export function verifyRuntimeComponentManifest(
  input: RuntimeComponentVerificationInput = {},
): RuntimeComponentVerificationReport {
  const checkedAt = (input.now || (() => new Date()))().toISOString()
  const override = developmentOverrideAllowed(input)
  const manifest = input.manifest
  const observedManifest = input.observedManifest || null
  const issues: RuntimeComponentVerificationIssue[] = []

  if (!manifest) {
    const loadIssue = input.manifestLoadIssue || {
      code: 'component_manifest_missing',
      message: 'Runtime component manifest is missing.',
    }
    issues.push(issue(loadIssue.code, loadIssue.message))
    return {
      format: RUNTIME_COMPONENT_MANIFEST_FORMAT,
      ok: false,
      generatedAt: observedManifest?.generatedAt || null,
      checkedAt,
      developmentOverride: override,
      components: observedManifest?.components.map(redactedComponent) || [],
      issues,
      redacted: true,
    }
  }

  if (manifest.format !== RUNTIME_COMPONENT_MANIFEST_FORMAT) {
    issues.push(issue('component_manifest_format_invalid', 'Runtime component manifest format is invalid.'))
  }

  const seen = new Set<string>()
  for (const component of manifest.components) {
    if (seen.has(component.id)) {
      issues.push(issue('component_duplicate', `Runtime component ${component.id} is duplicated.`, {
        componentId: component.id,
      }))
    }
    seen.add(component.id)

    if (!validComponentIdentity(component)) {
      issues.push(issue('component_identity_invalid', `Runtime component ${component.id || '(empty)'} has an invalid id or version.`, {
        componentId: component.id,
      }))
    }

    if (
      component.observedVersion
      && normalizeComponentVersion(component.version) !== normalizeComponentVersion(component.observedVersion)
    ) {
      issues.push(issue('component_version_mismatch', `Runtime component ${component.id} observed version does not match the manifest.`, {
        componentId: component.id,
      }))
    }

    if (!hasComponentSource(component)) {
      issues.push(issue('component_source_missing', `Runtime component ${component.id} must declare a path or URL source.`, {
        componentId: component.id,
      }))
    }

    if (component.sha256 && !validSha256(component.sha256)) {
      issues.push(issue('component_sha256_invalid', `Runtime component ${component.id} has an invalid SHA-256 digest.`, {
        componentId: component.id,
      }))
    }

    if (component.observedSha256 && !validSha256(component.observedSha256)) {
      issues.push(issue('component_observed_sha256_invalid', `Runtime component ${component.id} observed digest is invalid.`, {
        componentId: component.id,
      }))
    }

    if (
      component.sha256
      && component.observedSha256
      && validSha256(component.sha256)
      && validSha256(component.observedSha256)
      && normalizedSha256(component.sha256) !== normalizedSha256(component.observedSha256)
    ) {
      issues.push(issue('component_hash_mismatch', `Runtime component ${component.id} hash does not match the manifest.`, {
        componentId: component.id,
      }))
    }

    if (!componentHasReleaseEvidence(component) && !override) {
      issues.push(issue('component_provenance_missing', `Runtime component ${component.id} lacks hash or signature release evidence.`, {
        componentId: component.id,
      }))
    }

    if (component.compatibilityStatus === 'blocked') {
      issues.push(issue('component_compatibility_blocked', `Runtime component ${component.id} is blocked by compatibility policy.`, {
        componentId: component.id,
      }))
    }

    if (component.compatibilityStatus === 'unknown' && !override) {
      issues.push(issue('component_compatibility_unknown', `Runtime component ${component.id} has unknown compatibility status.`, {
        componentId: component.id,
        severity: 'warning',
      }))
    }
  }

  const errorIssues = issues.filter((entry) => entry.severity === 'error')
  return {
    format: RUNTIME_COMPONENT_MANIFEST_FORMAT,
    ok: errorIssues.length === 0,
    generatedAt: manifest.generatedAt,
    checkedAt,
    developmentOverride: override,
    components: manifest.components.map(redactedComponent),
    issues,
    redacted: true,
  }
}

export async function buildRuntimeComponentManifest(
  input: RuntimeComponentManifestBuildInput = {},
): Promise<RuntimeComponentManifest> {
  const generatedAt = input.generatedAt || (input.now || (() => new Date()))().toISOString()
  const opencodeCliPath = input.componentPaths?.['opencode-cli'] !== undefined
    ? input.componentPaths['opencode-cli'] || undefined
    : input.bundledOpencodeEnv?.opencodeBinPath
      || resolveBundledOpencodeBinaryPath()
      || resolveBundledOpencodeWrapperPath()
      || resolveBundledOpencodePackageJsonPath()
      || undefined
  const opencodeSdkPath = input.componentPaths?.['opencode-sdk'] !== undefined
    ? input.componentPaths['opencode-sdk'] || undefined
    : resolveBundledOpencodeSdkPackageJsonPath() || undefined
  const opencodeCliVersion = input.componentVersions?.['opencode-cli'] !== undefined
    ? input.componentVersions['opencode-cli']
    : await readBundledOpencodeCliVersion(input.bundledOpencodeEnv)
      || getBundledOpencodeVersion()
  const opencodeSdkVersion = input.componentVersions?.['opencode-sdk'] !== undefined
    ? input.componentVersions['opencode-sdk']
    : getBundledOpencodeSdkVersion()

  const components: RuntimeComponentManifestEntry[] = [
    runtimeComponent(input, {
      id: 'opencode-cli',
      kind: 'opencode-cli',
      version: opencodeCliVersion,
      upstreamVersion: normalizeComponentVersion(getBundledOpencodeVersion()),
      platform: process.platform,
      arch: process.arch,
      path: opencodeCliPath,
      requiredCapabilities: ['sessions', 'permissions', 'questions', 'events', 'mcp'],
    }),
    runtimeComponent(input, {
      id: 'opencode-sdk',
      kind: 'opencode-sdk',
      version: opencodeSdkVersion,
      platform: process.platform,
      arch: process.arch,
      path: opencodeSdkPath,
      requiredCapabilities: ['client', 'server', 'events'],
    }),
  ]

  for (const mcp of managedMcpComponents) {
    const packageJsonPath = resolveMcpPackageJsonPath(mcp.packageName, input)
    components.push(runtimeComponent(input, {
      id: mcp.id,
      kind: mcp.kind,
      version: input.componentVersions?.[mcp.id] || readPackageVersion(packageJsonPath),
      platform: process.platform,
      arch: process.arch,
      path: resolveMcpComponentPath(mcp.id, mcp.packageName, input),
      requiredCapabilities: mcp.capabilities,
    }))
  }

  return {
    format: RUNTIME_COMPONENT_MANIFEST_FORMAT,
    generatedAt,
    components,
  }
}

export function resolveRuntimeComponentManifestPath(input: RuntimeComponentManifestBuildInput = {}) {
  if (input.manifestPath !== undefined) return input.manifestPath

  const explicit = input.env?.OPEN_COWORK_RUNTIME_COMPONENT_MANIFEST?.trim()
    || process.env.OPEN_COWORK_RUNTIME_COMPONENT_MANIFEST?.trim()
  if (explicit) return explicit

  if (isPackaged(input)) {
    return join(input.resourcesPath || ((process as { resourcesPath?: string }).resourcesPath ?? process.cwd()), RUNTIME_COMPONENT_MANIFEST_FILE)
  }

  return null
}

export function loadRuntimeComponentManifest(path: string): {
  manifest: RuntimeComponentManifest | null
  issue: RuntimeComponentManifestLoadIssue | null
} {
  if (!existsSync(path)) {
    return { manifest: null, issue: manifestLoadIssueForPath(path) }
  }
  try {
    return { manifest: readJsonFile(path) as RuntimeComponentManifest, issue: null }
  } catch (error) {
    return {
      manifest: null,
      issue: {
        code: 'component_manifest_parse_failed',
        message: `Runtime component manifest could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
}

export function runtimeComponentDevelopmentOverrideFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeComponentDevelopmentOverride | undefined {
  const reason = env.OPEN_COWORK_RUNTIME_COMPONENT_DEV_OVERRIDE_REASON?.trim()
  return reason ? { enabled: true, reason } : undefined
}

export function runtimeComponentVerificationIsEnforced(input: RuntimeComponentManifestBuildInput = {}) {
  if (input.env?.OPEN_COWORK_RUNTIME_COMPONENT_ENFORCE === '1') return true
  return isPackaged(input)
}

export function formatRuntimeComponentVerificationFailure(report: RuntimeComponentVerificationReport) {
  const codes = report.issues
    .filter((entry) => entry.severity === 'error')
    .map((entry) => entry.componentId ? `${entry.componentId}:${entry.code}` : entry.code)
  return `Runtime component manifest verification failed (${codes.join(', ') || 'unknown'}).`
}

export async function buildRuntimeComponentVerificationReport(
  input: RuntimeComponentManifestBuildInput = {},
): Promise<RuntimeComponentVerificationReport> {
  const observedManifest = await buildRuntimeComponentManifest(input)
  const manifestPath = resolveRuntimeComponentManifestPath(input)
  const loaded = input.manifest !== undefined
    ? { manifest: input.manifest, issue: null }
    : manifestPath
      ? loadRuntimeComponentManifest(manifestPath)
      : { manifest: observedManifest, issue: null }
  const manifest = loaded.manifest
    ? mergeObservedComponentEvidence(loaded.manifest, observedManifest)
    : null

  return verifyRuntimeComponentManifest({
    manifest,
    observedManifest,
    manifestLoadIssue: loaded.issue,
    developmentOverride: input.developmentOverride || runtimeComponentDevelopmentOverrideFromEnv(input.env),
    now: input.now,
  })
}

export async function recordCurrentRuntimeComponentVerification(
  input: RuntimeComponentManifestBuildInput = {},
) {
  const report = await buildRuntimeComponentVerificationReport(input)
  recordRuntimeComponentVerification(report)
  if (!report.ok && runtimeComponentVerificationIsEnforced(input)) {
    throw new Error(formatRuntimeComponentVerificationFailure(report))
  }
  return report
}
