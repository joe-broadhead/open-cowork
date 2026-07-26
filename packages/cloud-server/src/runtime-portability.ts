import { sanitizeForExport } from '@open-cowork/shared'
import { execFile } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isRuntimeSnapshotSecretBearingPath } from './runtime-snapshot-portability.ts'

export const SANDBOX_COMPONENT_MANIFEST_FORMAT = 'open-cowork-sandbox-component-manifest-v1'

export type SandboxEngine = 'docker' | 'apple-container'
export type SandboxMountMode = 'read-only' | 'read-write'
export type SandboxMountPurpose =
  | 'workspace'
  | 'runtime-home'
  | 'runtime-cache'
  | 'artifact'
  | 'metadata'

export interface SandboxMountPolicy {
  source: string
  target: string
  mode: SandboxMountMode
  purpose: SandboxMountPurpose
  allowSecretBearing?: boolean
}

export interface SandboxDevelopmentOverride {
  enabled: boolean
  allowSecretMounts?: boolean
  reason?: string
}

export interface SandboxComponentManifestEntry {
  id: string
  kind: 'image' | 'helper'
  source: string
  sha256?: string
  signature?: string
  verified: boolean
}

export interface SandboxComponentManifest {
  format: typeof SANDBOX_COMPONENT_MANIFEST_FORMAT
  components: SandboxComponentManifestEntry[]
}

export interface SandboxPolicyInput {
  engine: SandboxEngine
  imageComponentId: string
  helperComponentIds?: string[]
  mounts: SandboxMountPolicy[]
  allowedSourceRoots: string[]
  componentManifest?: SandboxComponentManifest | null
  developmentOverride?: SandboxDevelopmentOverride
}

export interface SandboxPolicyPlan {
  ok: boolean
  engine: SandboxEngine
  components: SandboxComponentManifestEntry[]
  mounts: Array<SandboxMountPolicy & { source: string }>
  blockers: string[]
  developmentOverride: boolean
}

export type SandboxRuntimeCommandKind = 'start' | 'status' | 'stop' | 'cleanup'
export type SandboxRuntimeLifecycleStatus = 'planned' | 'running' | 'stopped' | 'failed'

export interface SandboxRuntimeCommandPlan {
  kind: SandboxRuntimeCommandKind
  // Internal runner argv. Export diagnostics with redactedArgs instead.
  command: string
  args: string[]
  redactedArgs: string[]
}

export type SandboxRuntimeEngineCheckReasonCode =
  | 'sandbox-runtime-engine-available'
  | 'sandbox-runtime-engine-unavailable'
  | 'sandbox-runtime-engine-check-failed'

export interface SandboxRuntimeEngineCheckResult {
  ok: boolean
  reasonCode: SandboxRuntimeEngineCheckReasonCode
  engine: SandboxEngine
  command: string
  args: string[]
  redactedArgs: string[]
  version?: string
  output?: string
  redacted: true
}

export interface SandboxRuntimeLaunchInput extends SandboxPolicyInput {
  runtimeId?: string | null
  ownership?: SandboxRuntimeOwnership
  command?: string[]
  entrypoint?: string
  workingDirectory?: string
  environmentFile?: string
  runAsUser?: string
  readOnlyRootFilesystem?: boolean
  networkPolicy?: SandboxRuntimeNetworkPolicy
  publishPorts?: SandboxRuntimePublishedPort[]
  resourceLimits?: SandboxRuntimeResourceLimits
}

export interface SandboxRuntimeOwnership {
  workerOwner: string
  leaseId: string
}

export type SandboxRuntimeNetworkPolicy =
  | { kind: 'deny-all' }
  | {
    kind: 'restricted'
    networkName: string
    policyId: string
  }

export interface SandboxRuntimePublishedPort {
  containerPort: number
  protocol?: 'tcp' | 'udp'
  hostAddress?: string
}

export interface SandboxRuntimeResourceLimits {
  memoryBytes?: number
  cpuCount?: number
  pids?: number
}

export interface SandboxRuntimeLaunchPlan {
  ok: boolean
  engine: SandboxEngine
  runtimeId: string
  image: string | null
  components: SandboxComponentManifestEntry[]
  mounts: Array<SandboxMountPolicy & { source: string }>
  commands: Record<SandboxRuntimeCommandKind, SandboxRuntimeCommandPlan>
  blockers: string[]
  developmentOverride: boolean
  networkPolicy: SandboxRuntimeNetworkPolicy
}

export interface SandboxRuntimeState {
  runtimeId: string
  engine: SandboxEngine
  status: SandboxRuntimeLifecycleStatus
  startedAt?: string
  updatedAt: string
  exitCode?: number | null
  output?: string
  redacted: true
}

export interface SandboxRuntimeCommandRunner {
  run(command: string, args: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }>
}

export interface SandboxRuntimeLifecycleResult {
  ok: boolean
  reasonCode:
    | 'sandbox-runtime-started'
    | 'sandbox-runtime-stopped'
    | 'sandbox-runtime-status-read'
    | 'sandbox-runtime-policy-blocked'
    | 'sandbox-runtime-command-failed'
  plan: SandboxRuntimeLaunchPlan
  state: SandboxRuntimeState
}

export interface SandboxRuntimeSmokeResult {
  ok: boolean
  reasonCode:
    | 'sandbox-runtime-smoke-passed'
    | 'sandbox-runtime-smoke-failed'
    | 'sandbox-runtime-policy-blocked'
  start: SandboxRuntimeLifecycleResult
  status?: SandboxRuntimeLifecycleResult
  stop?: SandboxRuntimeLifecycleResult
  events: Array<{
    phase: SandboxRuntimeCommandKind
    ok: boolean
    reasonCode: SandboxRuntimeLifecycleResult['reasonCode']
    status: SandboxRuntimeLifecycleStatus
  }>
  redacted: true
}

export interface SandboxRuntimeOneShotResult {
  ok: boolean
  reasonCode:
    | 'sandbox-runtime-one-shot-passed'
    | 'sandbox-runtime-policy-blocked'
    | 'sandbox-runtime-command-failed'
  plan: SandboxRuntimeLaunchPlan
  command: SandboxRuntimeCommandPlan
  state: SandboxRuntimeState
}

const execFileAsync = promisify(execFile)
const SANDBOX_RUNTIME_ID_MAX_LENGTH = 63
export const SANDBOX_RUNTIME_LABEL = 'open-cowork.sandbox'
export const SANDBOX_RUNTIME_ID_LABEL = `${SANDBOX_RUNTIME_LABEL}.runtime_id`
export const SANDBOX_RUNTIME_OWNER_LABEL = `${SANDBOX_RUNTIME_LABEL}.worker_owner`
export const SANDBOX_RUNTIME_LEASE_LABEL = `${SANDBOX_RUNTIME_LABEL}.lease_id`

function pathInside(root: string, candidate: string) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function validContainerTarget(target: string) {
  return target.startsWith('/')
    && !target.includes('\0')
    && !target.split('/').some((segment) => segment === '..')
}

function validSandboxRuntimeId(runtimeId: string) {
  return runtimeId.length > 0
    && runtimeId.length <= SANDBOX_RUNTIME_ID_MAX_LENGTH
    && /^[a-z0-9][a-z0-9_.-]*$/i.test(runtimeId)
}

function normalizeSandboxRuntimeId(input: SandboxRuntimeLaunchInput) {
  const raw = (input.runtimeId?.trim() || `open-cowork-${input.imageComponentId}`).toLowerCase()
  const collapsed = raw
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
  // Linear-time trim of leading/trailing `[_.-]` runs. A regex such as
  // /^[_.-]+|[_.-]+$/g exhibits super-linear (quadratic) backtracking on long
  // delimiter runs because the trailing-anchored branch is retried from every
  // start offset; the explicit two-pointer scan is O(n) and behaves identically.
  let start = 0
  let end = collapsed.length
  while (start < end && '_.-'.includes(collapsed[start])) start++
  while (end > start && '_.-'.includes(collapsed[end - 1])) end--
  return collapsed.slice(start, end).slice(0, SANDBOX_RUNTIME_ID_MAX_LENGTH)
}

function imageReferenceFromComponent(component: SandboxComponentManifestEntry | undefined) {
  if (!component || component.kind !== 'image') return null
  return component.source
    .replace(/^docker:\/\//, '')
    .replace(/^oci:\/\//, '')
    .trim()
}

function validImageReference(image: string) {
  return image.length > 0 && !/[\s\0]/.test(image)
}

function validMountCommandValue(value: string) {
  return !value.includes('\0') && !value.includes(',')
}

function redactedSandboxArg(arg: string, mounts: Array<SandboxMountPolicy & { source: string }>) {
  let redacted = arg
  for (const mount of mounts) {
    redacted = redacted.split(mount.source).join('[redacted-path]')
  }
  return sanitizeForExport(redacted)
}

function sandboxCommandPlan(
  kind: SandboxRuntimeCommandKind,
  command: string,
  args: string[],
  mounts: Array<SandboxMountPolicy & { source: string }>,
  sensitiveHostPaths: string[] = [],
): SandboxRuntimeCommandPlan {
  const redactionMounts = [
    ...mounts,
    ...sensitiveHostPaths.map((source) => ({
      source,
      target: '[redacted-path]',
      mode: 'read-only' as const,
      purpose: 'metadata' as const,
    })),
  ]
  return {
    kind,
    command,
    args,
    redactedArgs: args.map((arg) => redactedSandboxArg(arg, redactionMounts)),
  }
}

function emptySandboxRuntimeCommands(): Record<SandboxRuntimeCommandKind, SandboxRuntimeCommandPlan> {
  const empty = (kind: SandboxRuntimeCommandKind) => sandboxCommandPlan(kind, '', [], [])
  return {
    start: empty('start'),
    status: empty('status'),
    stop: empty('stop'),
    cleanup: empty('cleanup'),
  }
}

function sandboxRuntimeEngineCheckCommand(engine: SandboxEngine): SandboxRuntimeCommandPlan {
  return engine === 'docker'
    ? sandboxCommandPlan('status', 'docker', ['version', '--format', '{{.Server.Version}}'], [])
    : sandboxCommandPlan('status', 'container', ['system', 'status'], [])
}

function sandboxRuntimeEngineUnavailable(output: string | undefined) {
  return !output || /enoent|not found|command not found|no such file|cannot connect to the docker daemon|docker daemon|container service/i.test(output)
}

function dockerMountArg(mount: SandboxMountPolicy & { source: string }) {
  const mode = mount.mode === 'read-only' ? ',readonly' : ''
  return `type=bind,src=${mount.source},dst=${mount.target}${mode}`
}

function appleContainerMountArg(mount: SandboxMountPolicy & { source: string }) {
  const mode = mount.mode === 'read-only' ? ',readonly' : ''
  return `type=bind,source=${mount.source},target=${mount.target}${mode}`
}

function sandboxRuntimeLabels(
  runtimeId: string,
  ownership: SandboxRuntimeOwnership | undefined,
) {
  return [
    `${SANDBOX_RUNTIME_LABEL}=true`,
    `${SANDBOX_RUNTIME_ID_LABEL}=${runtimeId}`,
    ...(ownership
      ? [
          `${SANDBOX_RUNTIME_OWNER_LABEL}=${ownership.workerOwner}`,
          `${SANDBOX_RUNTIME_LEASE_LABEL}=${ownership.leaseId}`,
        ]
      : []),
  ]
}

function appendSandboxRuntimeLabels(
  args: string[],
  runtimeId: string,
  ownership: SandboxRuntimeOwnership | undefined,
) {
  for (const label of sandboxRuntimeLabels(runtimeId, ownership)) {
    args.push('--label', label)
  }
}

function dockerSandboxRuntimeCommands(input: {
  runtimeId: string
  image: string
  mounts: Array<SandboxMountPolicy & { source: string }>
  commandArgs: string[]
  launch: SandboxRuntimeLaunchInput
}): Record<SandboxRuntimeCommandKind, SandboxRuntimeCommandPlan> {
  const startArgs = [
    'run',
    '--detach',
    '--rm',
    '--pull',
    'never',
    '--name',
    input.runtimeId,
    '--network',
    input.launch.networkPolicy?.kind === 'restricted'
      ? input.launch.networkPolicy.networkName
      : 'none',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--init',
  ]
  appendSandboxRuntimeLabels(startArgs, input.runtimeId, input.launch.ownership)
  if (input.launch.readOnlyRootFilesystem !== false) {
    startArgs.push('--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456')
  }
  if (input.launch.runAsUser) startArgs.push('--user', input.launch.runAsUser)
  if (input.launch.workingDirectory) startArgs.push('--workdir', input.launch.workingDirectory)
  if (input.launch.entrypoint) startArgs.push('--entrypoint', input.launch.entrypoint)
  if (input.launch.environmentFile) startArgs.push('--env-file', input.launch.environmentFile)
  const limits = input.launch.resourceLimits
  if (limits?.memoryBytes) startArgs.push('--memory', String(limits.memoryBytes))
  if (limits?.cpuCount) startArgs.push('--cpus', String(limits.cpuCount))
  if (limits?.pids) startArgs.push('--pids-limit', String(limits.pids))
  for (const port of input.launch.publishPorts || []) {
    startArgs.push(
      '--publish',
      `${port.hostAddress || '127.0.0.1'}::${port.containerPort}/${port.protocol || 'tcp'}`,
    )
  }
  for (const mount of input.mounts) {
    startArgs.push('--mount', dockerMountArg(mount))
  }
  startArgs.push(input.image, ...input.commandArgs)
  const sensitiveHostPaths = input.launch.environmentFile ? [input.launch.environmentFile] : []

  return {
    start: sandboxCommandPlan('start', 'docker', startArgs, input.mounts, sensitiveHostPaths),
    status: sandboxCommandPlan(
      'status',
      'docker',
      ['inspect', '--format', '{{.State.Status}}', input.runtimeId],
      input.mounts,
    ),
    stop: sandboxCommandPlan('stop', 'docker', ['stop', input.runtimeId], input.mounts),
    cleanup: sandboxCommandPlan('cleanup', 'docker', ['rm', '-f', input.runtimeId], input.mounts),
  }
}

function appleContainerSandboxRuntimeCommands(input: {
  runtimeId: string
  image: string
  mounts: Array<SandboxMountPolicy & { source: string }>
  commandArgs: string[]
  launch: SandboxRuntimeLaunchInput
}): Record<SandboxRuntimeCommandKind, SandboxRuntimeCommandPlan> {
  const startArgs = [
    'run',
    '--detach',
    '--rm',
    '--name',
    input.runtimeId,
    '--network',
    input.launch.networkPolicy?.kind === 'restricted'
      ? input.launch.networkPolicy.networkName
      : 'none',
    '--cap-drop',
    'ALL',
  ]
  appendSandboxRuntimeLabels(startArgs, input.runtimeId, input.launch.ownership)
  if (input.launch.runAsUser) startArgs.push('--user', input.launch.runAsUser)
  if (input.launch.workingDirectory) startArgs.push('--workdir', input.launch.workingDirectory)
  if (input.launch.entrypoint) startArgs.push('--entrypoint', input.launch.entrypoint)
  if (input.launch.environmentFile) startArgs.push('--env-file', input.launch.environmentFile)
  for (const port of input.launch.publishPorts || []) {
    startArgs.push(
      '--publish',
      `${port.hostAddress || '127.0.0.1'}::${port.containerPort}/${port.protocol || 'tcp'}`,
    )
  }
  for (const mount of input.mounts) {
    startArgs.push('--mount', appleContainerMountArg(mount))
  }
  startArgs.push(input.image, ...input.commandArgs)
  const sensitiveHostPaths = input.launch.environmentFile ? [input.launch.environmentFile] : []

  return {
    start: sandboxCommandPlan('start', 'container', startArgs, input.mounts, sensitiveHostPaths),
    status: sandboxCommandPlan('status', 'container', ['inspect', input.runtimeId], input.mounts),
    stop: sandboxCommandPlan('stop', 'container', ['stop', input.runtimeId], input.mounts),
    cleanup: sandboxCommandPlan('cleanup', 'container', ['delete', input.runtimeId], input.mounts),
  }
}

function dockerSandboxRuntimeOneShotCommand(input: {
  runtimeId: string
  image: string
  mounts: Array<SandboxMountPolicy & { source: string }>
  commandArgs: string[]
  launch: SandboxRuntimeLaunchInput
}): SandboxRuntimeCommandPlan {
  const args = [
    'run',
    '--rm',
    '--pull',
    'never',
    '--name',
    input.runtimeId,
    '--network',
    input.launch.networkPolicy?.kind === 'restricted'
      ? input.launch.networkPolicy.networkName
      : 'none',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--init',
  ]
  appendSandboxRuntimeLabels(args, input.runtimeId, input.launch.ownership)
  if (input.launch.readOnlyRootFilesystem !== false) {
    args.push('--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456')
  }
  if (input.launch.runAsUser) args.push('--user', input.launch.runAsUser)
  if (input.launch.workingDirectory) args.push('--workdir', input.launch.workingDirectory)
  if (input.launch.entrypoint) args.push('--entrypoint', input.launch.entrypoint)
  if (input.launch.environmentFile) args.push('--env-file', input.launch.environmentFile)
  const limits = input.launch.resourceLimits
  if (limits?.memoryBytes) args.push('--memory', String(limits.memoryBytes))
  if (limits?.cpuCount) args.push('--cpus', String(limits.cpuCount))
  if (limits?.pids) args.push('--pids-limit', String(limits.pids))
  for (const mount of input.mounts) {
    args.push('--mount', dockerMountArg(mount))
  }
  args.push(input.image, ...input.commandArgs)
  return sandboxCommandPlan(
    'start',
    'docker',
    args,
    input.mounts,
    input.launch.environmentFile ? [input.launch.environmentFile] : [],
  )
}

function appleContainerSandboxRuntimeOneShotCommand(input: {
  runtimeId: string
  image: string
  mounts: Array<SandboxMountPolicy & { source: string }>
  commandArgs: string[]
  launch: SandboxRuntimeLaunchInput
}): SandboxRuntimeCommandPlan {
  const args = [
    'run',
    '--rm',
    '--name',
    input.runtimeId,
    '--network',
    input.launch.networkPolicy?.kind === 'restricted'
      ? input.launch.networkPolicy.networkName
      : 'none',
    '--cap-drop',
    'ALL',
  ]
  appendSandboxRuntimeLabels(args, input.runtimeId, input.launch.ownership)
  if (input.launch.runAsUser) args.push('--user', input.launch.runAsUser)
  if (input.launch.workingDirectory) args.push('--workdir', input.launch.workingDirectory)
  if (input.launch.entrypoint) args.push('--entrypoint', input.launch.entrypoint)
  if (input.launch.environmentFile) args.push('--env-file', input.launch.environmentFile)
  for (const mount of input.mounts) {
    args.push('--mount', appleContainerMountArg(mount))
  }
  args.push(input.image, ...input.commandArgs)
  return sandboxCommandPlan(
    'start',
    'container',
    args,
    input.mounts,
    input.launch.environmentFile ? [input.launch.environmentFile] : [],
  )
}

function sandboxRuntimeBlockedState(
  input: SandboxRuntimeLaunchInput,
  status: SandboxRuntimeLifecycleStatus,
  exitCode: number | null = null,
): SandboxRuntimeState {
  return {
    runtimeId: normalizeSandboxRuntimeId(input),
    engine: input.engine,
    status,
    updatedAt: new Date().toISOString(),
    exitCode,
    redacted: true,
  }
}

function sandboxRuntimeOutput(
  stdout: string | Buffer | undefined,
  stderr: string | Buffer | undefined,
  mounts: Array<SandboxMountPolicy & { source: string }>,
) {
  const output = [stdout?.toString(), stderr?.toString()].filter(Boolean).join('\n').trim()
  return output ? redactedSandboxArg(output, mounts) : undefined
}

async function defaultSandboxRuntimeCommandRunner(command: string, args: string[]) {
  try {
    const result = await execFileAsync(command, args, { timeout: 30_000, windowsHide: true })
    return {
      exitCode: 0,
      stdout: result.stdout?.toString(),
      stderr: result.stderr?.toString(),
    }
  } catch (err) {
    const error = err as {
      code?: number
      stdout?: string | Buffer
      stderr?: string | Buffer
      message?: string
    }
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout?.toString(),
      stderr: error.stderr?.toString() || error.message,
    }
  }
}

export async function runSandboxRuntimeCommand(
  command: string,
  args: string[],
  runner?: SandboxRuntimeCommandRunner,
) {
  return (runner || { run: defaultSandboxRuntimeCommandRunner }).run(command, args)
}

export async function checkSandboxRuntimeEngine(
  engine: SandboxEngine,
  runner?: SandboxRuntimeCommandRunner,
): Promise<SandboxRuntimeEngineCheckResult> {
  const commandPlan = sandboxRuntimeEngineCheckCommand(engine)
  const commandRunner = runner || { run: defaultSandboxRuntimeCommandRunner }
  const result = await commandRunner.run(commandPlan.command, commandPlan.args)
  const output = sandboxRuntimeOutput(result.stdout, result.stderr, [])
  const ok = result.exitCode === 0
  const reasonCode: SandboxRuntimeEngineCheckReasonCode = ok
    ? 'sandbox-runtime-engine-available'
    : sandboxRuntimeEngineUnavailable(output)
      ? 'sandbox-runtime-engine-unavailable'
      : 'sandbox-runtime-engine-check-failed'
  return {
    ok,
    reasonCode,
    engine,
    command: commandPlan.command,
    args: commandPlan.args,
    redactedArgs: commandPlan.redactedArgs,
    ...(ok && output ? { version: output.trim().split(/\s+/)[0] } : {}),
    ...(output ? { output } : {}),
    redacted: true,
  }
}

function resolveSandboxComponents(input: SandboxPolicyInput) {
  const blockers: string[] = []
  const manifest = input.componentManifest
  const override = input.developmentOverride?.enabled === true && Boolean(input.developmentOverride.reason?.trim())
  if (!manifest || manifest.format !== SANDBOX_COMPONENT_MANIFEST_FORMAT) {
    return {
      components: [] as SandboxComponentManifestEntry[],
      blockers: ['sandbox-component-manifest-missing'],
    }
  }

  const ids = [input.imageComponentId, ...(input.helperComponentIds || [])]
  const manifestIds = new Set<string>()
  for (const component of manifest.components) {
    if (manifestIds.has(component.id)) blockers.push(`sandbox-component-duplicate:${component.id}`)
    manifestIds.add(component.id)
    if (!component.source.trim()) blockers.push(`sandbox-component-source-missing:${component.id}`)
    if (component.sha256 && !validSandboxComponentSha256(component.sha256)) {
      blockers.push(`sandbox-component-sha256-invalid:${component.id}`)
    }
  }

  const components: SandboxComponentManifestEntry[] = []
  for (const id of ids) {
    const component = manifest.components.find((componentEntry) => componentEntry.id === id)
    if (!component) {
      blockers.push(`sandbox-component-missing:${id}`)
      continue
    }
    if (!component.verified && !override) {
      blockers.push(`sandbox-component-unverified:${id}`)
      continue
    }
    if (!sandboxComponentHasReleaseEvidence(component) && !override) {
      blockers.push(`sandbox-component-provenance-missing:${id}`)
      continue
    }
    components.push(component)
  }
  return { components, blockers }
}

function validSandboxComponentSha256(value: string) {
  return /^(sha256:)?[a-f0-9]{64}$/i.test(value)
}

function sandboxComponentHasReleaseEvidence(component: SandboxComponentManifestEntry) {
  return Boolean((component.sha256 && validSandboxComponentSha256(component.sha256)) || component.signature?.trim())
}

export function planSandboxPolicy(input: SandboxPolicyInput): SandboxPolicyPlan {
  const blockers: string[] = []
  const allowedRoots = input.allowedSourceRoots.map((root) => resolve(root))
  const developmentOverride = input.developmentOverride?.enabled === true
  const secretMountOverride = developmentOverride
    && input.developmentOverride?.allowSecretMounts === true
    && Boolean(input.developmentOverride.reason?.trim())

  const resolvedMounts = input.mounts.map((mount) => ({
    ...mount,
    source: resolve(mount.source),
  }))

  for (const [index, mount] of resolvedMounts.entries()) {
    const originalSource = input.mounts[index]?.source || mount.source
    if (!isAbsolute(originalSource)) blockers.push(`sandbox-mount-source-not-absolute:${originalSource}`)
    if (!validContainerTarget(mount.target)) blockers.push(`sandbox-mount-target-invalid:${mount.target}`)
    if (!allowedRoots.some((root) => pathInside(root, mount.source))) {
      blockers.push(`sandbox-mount-source-not-allowlisted:${mount.source}`)
    }
    if (isRuntimeSnapshotSecretBearingPath(mount.source) && !(mount.allowSecretBearing && secretMountOverride)) {
      blockers.push(`sandbox-mount-secret-bearing:${mount.source}`)
    }
  }

  const componentResult = resolveSandboxComponents(input)
  blockers.push(...componentResult.blockers)

  return {
    ok: blockers.length === 0,
    engine: input.engine,
    components: componentResult.components,
    mounts: resolvedMounts,
    blockers,
    developmentOverride,
  }
}

export function createSandboxRuntimeLaunchPlan(input: SandboxRuntimeLaunchInput): SandboxRuntimeLaunchPlan {
  const policy = planSandboxPolicy(input)
  const blockers = [...policy.blockers]
  const runtimeId = normalizeSandboxRuntimeId(input)
  const networkPolicy = input.networkPolicy || { kind: 'deny-all' as const }
  if (!validSandboxRuntimeId(runtimeId)) blockers.push(`sandbox-runtime-id-invalid:${input.runtimeId || runtimeId}`)

  const image = imageReferenceFromComponent(policy.components.find((component) => component.id === input.imageComponentId))
  if (!image) blockers.push(`sandbox-runtime-image-missing:${input.imageComponentId}`)
  else if (!validImageReference(image)) blockers.push(`sandbox-runtime-image-invalid:${input.imageComponentId}`)

  for (const mount of policy.mounts) {
    if (!validMountCommandValue(mount.source)) blockers.push(`sandbox-mount-source-command-unsafe:${mount.source}`)
    if (!validMountCommandValue(mount.target)) blockers.push(`sandbox-mount-target-command-unsafe:${mount.target}`)
  }

  const commandArgs = input.command || []
  for (const arg of commandArgs) {
    if (arg.includes('\0')) blockers.push('sandbox-runtime-command-arg-invalid')
  }
  if (input.entrypoint?.includes('\0')) blockers.push('sandbox-runtime-entrypoint-invalid')
  if (input.workingDirectory && !validContainerTarget(input.workingDirectory)) {
    blockers.push(`sandbox-runtime-working-directory-invalid:${input.workingDirectory}`)
  }
  if (input.runAsUser && !/^[0-9]+(?::[0-9]+)?$/.test(input.runAsUser)) {
    blockers.push('sandbox-runtime-user-invalid')
  }
  if (
    input.ownership
    && !/^[a-f0-9]{32}$/.test(input.ownership.workerOwner)
  ) {
    blockers.push('sandbox-runtime-worker-owner-invalid')
  }
  if (
    input.ownership
    && !/^[a-f0-9]{32}$/.test(input.ownership.leaseId)
  ) {
    blockers.push('sandbox-runtime-lease-id-invalid')
  }
  if (input.environmentFile) {
    const environmentFile = resolve(input.environmentFile)
    if (!isAbsolute(input.environmentFile)) blockers.push('sandbox-runtime-env-file-not-absolute')
    if (!input.allowedSourceRoots.some((root) => pathInside(resolve(root), environmentFile))) {
      blockers.push('sandbox-runtime-env-file-not-allowlisted')
    }
  }
  if (networkPolicy.kind === 'restricted') {
    if (!networkPolicy.networkName.trim()) blockers.push('sandbox-runtime-network-name-missing')
    if (!networkPolicy.policyId.trim()) blockers.push('sandbox-runtime-egress-policy-id-missing')
    if (/[\0\s]/.test(networkPolicy.networkName)) blockers.push('sandbox-runtime-network-name-invalid')
  }
  for (const port of input.publishPorts || []) {
    if (!Number.isInteger(port.containerPort) || port.containerPort < 1 || port.containerPort > 65_535) {
      blockers.push(`sandbox-runtime-publish-port-invalid:${port.containerPort}`)
    }
    if ((port.hostAddress || '127.0.0.1') !== '127.0.0.1' && (port.hostAddress || '') !== '::1') {
      blockers.push('sandbox-runtime-publish-address-not-loopback')
    }
  }
  if (input.engine !== 'docker' && input.resourceLimits) {
    blockers.push('sandbox-runtime-resource-limits-unsupported')
  }
  const limits = input.resourceLimits
  if (limits?.memoryBytes !== undefined && (!Number.isSafeInteger(limits.memoryBytes) || limits.memoryBytes <= 0)) {
    blockers.push('sandbox-runtime-memory-limit-invalid')
  }
  if (limits?.cpuCount !== undefined && (!Number.isFinite(limits.cpuCount) || limits.cpuCount <= 0)) {
    blockers.push('sandbox-runtime-cpu-limit-invalid')
  }
  if (limits?.pids !== undefined && (!Number.isSafeInteger(limits.pids) || limits.pids <= 0)) {
    blockers.push('sandbox-runtime-pids-limit-invalid')
  }

  const ok = blockers.length === 0 && Boolean(image)
  const commands = ok
    ? input.engine === 'docker'
      ? dockerSandboxRuntimeCommands({
        runtimeId,
        image: image!,
        mounts: policy.mounts,
        commandArgs,
        launch: input,
      })
      : appleContainerSandboxRuntimeCommands({
        runtimeId,
        image: image!,
        mounts: policy.mounts,
        commandArgs,
        launch: input,
      })
    : emptySandboxRuntimeCommands()

  return {
    ok,
    engine: input.engine,
    runtimeId,
    image,
    components: policy.components,
    mounts: policy.mounts,
    commands,
    blockers,
    developmentOverride: policy.developmentOverride,
    networkPolicy,
  }
}

async function runSandboxRuntimeLifecycleCommand(input: {
  plan: SandboxRuntimeLaunchPlan
  kind: SandboxRuntimeCommandKind
  successReasonCode: SandboxRuntimeLifecycleResult['reasonCode']
  successStatus: SandboxRuntimeLifecycleStatus
  failureStatus: SandboxRuntimeLifecycleStatus
  startedAt?: string
  runner?: SandboxRuntimeCommandRunner
}): Promise<SandboxRuntimeLifecycleResult> {
  const now = new Date().toISOString()
  if (!input.plan.ok) {
    return {
      ok: false,
      reasonCode: 'sandbox-runtime-policy-blocked',
      plan: input.plan,
      state: {
        runtimeId: input.plan.runtimeId,
        engine: input.plan.engine,
        status: input.failureStatus,
        updatedAt: now,
        redacted: true,
      },
    }
  }

  const commandPlan = input.plan.commands[input.kind]
  if (!commandPlan.command) {
    return {
      ok: false,
      reasonCode: 'sandbox-runtime-command-failed',
      plan: input.plan,
      state: {
        runtimeId: input.plan.runtimeId,
        engine: input.plan.engine,
        status: input.failureStatus,
        updatedAt: now,
        exitCode: 1,
        output: 'sandbox runtime command unavailable',
        redacted: true,
      },
    }
  }

  const runner = input.runner || { run: defaultSandboxRuntimeCommandRunner }
  const result = await runner.run(commandPlan.command, commandPlan.args)
  const ok = result.exitCode === 0
  const updatedAt = new Date().toISOString()
  return {
    ok,
    reasonCode: ok ? input.successReasonCode : 'sandbox-runtime-command-failed',
    plan: input.plan,
    state: {
      runtimeId: input.plan.runtimeId,
      engine: input.plan.engine,
      status: ok ? input.successStatus : input.failureStatus,
      startedAt: input.startedAt,
      updatedAt,
      exitCode: result.exitCode,
      output: sandboxRuntimeOutput(result.stdout, result.stderr, input.plan.mounts),
      redacted: true,
    },
  }
}

export async function startSandboxRuntime(
  input: SandboxRuntimeLaunchInput,
  runner?: SandboxRuntimeCommandRunner,
): Promise<SandboxRuntimeLifecycleResult> {
  const plan = createSandboxRuntimeLaunchPlan(input)
  const startedAt = new Date().toISOString()
  if (!plan.ok) {
    return {
      ok: false,
      reasonCode: 'sandbox-runtime-policy-blocked',
      plan,
      state: sandboxRuntimeBlockedState(input, 'failed', null),
    }
  }
  return runSandboxRuntimeLifecycleCommand({
    plan,
    kind: 'start',
    successReasonCode: 'sandbox-runtime-started',
    successStatus: 'running',
    failureStatus: 'failed',
    startedAt,
    runner,
  })
}

export async function readSandboxRuntimeStatus(
  plan: SandboxRuntimeLaunchPlan,
  runner?: SandboxRuntimeCommandRunner,
): Promise<SandboxRuntimeLifecycleResult> {
  return runSandboxRuntimeLifecycleCommand({
    plan,
    kind: 'status',
    successReasonCode: 'sandbox-runtime-status-read',
    successStatus: 'running',
    failureStatus: 'failed',
    runner,
  })
}

export async function stopSandboxRuntime(
  plan: SandboxRuntimeLaunchPlan,
  runner?: SandboxRuntimeCommandRunner,
): Promise<SandboxRuntimeLifecycleResult> {
  const stopResult = await runSandboxRuntimeLifecycleCommand({
    plan,
    kind: 'stop',
    successReasonCode: 'sandbox-runtime-stopped',
    successStatus: 'stopped',
    failureStatus: 'failed',
    runner,
  })
  if (!plan.ok) return stopResult

  const cleanupResult = await runSandboxRuntimeLifecycleCommand({
    plan,
    kind: 'cleanup',
    successReasonCode: 'sandbox-runtime-stopped',
    successStatus: 'stopped',
    failureStatus: 'failed',
    runner,
  })
  const absent = /no such (container|runtime)|not found/i.test(
    `${stopResult.state.output || ''}\n${cleanupResult.state.output || ''}`,
  )
  if (cleanupResult.ok || absent) {
    return {
      ...cleanupResult,
      ok: true,
      reasonCode: 'sandbox-runtime-stopped',
      state: {
        ...cleanupResult.state,
        status: 'stopped',
        exitCode: 0,
        output: absent ? undefined : cleanupResult.state.output,
      },
    }
  }
  return stopResult.ok ? cleanupResult : stopResult
}

export async function runSandboxRuntimeSmoke(
  input: SandboxRuntimeLaunchInput,
  runner?: SandboxRuntimeCommandRunner,
): Promise<SandboxRuntimeSmokeResult> {
  const events: SandboxRuntimeSmokeResult['events'] = []
  const start = await startSandboxRuntime(input, runner)
  events.push({
    phase: 'start',
    ok: start.ok,
    reasonCode: start.reasonCode,
    status: start.state.status,
  })
  if (!start.ok) {
    return {
      ok: false,
      reasonCode: start.reasonCode === 'sandbox-runtime-policy-blocked'
        ? 'sandbox-runtime-policy-blocked'
        : 'sandbox-runtime-smoke-failed',
      start,
      events,
      redacted: true,
    }
  }

  const status = await readSandboxRuntimeStatus(start.plan, runner)
  events.push({
    phase: 'status',
    ok: status.ok,
    reasonCode: status.reasonCode,
    status: status.state.status,
  })

  const stop = await stopSandboxRuntime(start.plan, runner)
  events.push({
    phase: 'stop',
    ok: stop.ok,
    reasonCode: stop.reasonCode,
    status: stop.state.status,
  })

  return {
    ok: start.ok && status.ok && stop.ok,
    reasonCode: start.ok && status.ok && stop.ok
      ? 'sandbox-runtime-smoke-passed'
      : 'sandbox-runtime-smoke-failed',
    start,
    status,
    stop,
    events,
    redacted: true,
  }
}

export async function runSandboxRuntimeOneShot(
  input: SandboxRuntimeLaunchInput,
  runner?: SandboxRuntimeCommandRunner,
): Promise<SandboxRuntimeOneShotResult> {
  const plan = createSandboxRuntimeLaunchPlan(input)
  const command = plan.ok && plan.image
    ? input.engine === 'docker'
      ? dockerSandboxRuntimeOneShotCommand({
        runtimeId: plan.runtimeId,
        image: plan.image,
        mounts: plan.mounts,
        commandArgs: input.command || [],
        launch: input,
      })
      : appleContainerSandboxRuntimeOneShotCommand({
        runtimeId: plan.runtimeId,
        image: plan.image,
        mounts: plan.mounts,
        commandArgs: input.command || [],
        launch: input,
      })
    : sandboxCommandPlan('start', '', [], [])

  if (!plan.ok) {
    return {
      ok: false,
      reasonCode: 'sandbox-runtime-policy-blocked',
      plan,
      command,
      state: sandboxRuntimeBlockedState(input, 'failed', null),
    }
  }

  const startedAt = new Date().toISOString()
  const commandRunner = runner || { run: defaultSandboxRuntimeCommandRunner }
  const result = await commandRunner.run(command.command, command.args)
  const ok = result.exitCode === 0
  return {
    ok,
    reasonCode: ok ? 'sandbox-runtime-one-shot-passed' : 'sandbox-runtime-command-failed',
    plan,
    command,
    state: {
      runtimeId: plan.runtimeId,
      engine: plan.engine,
      status: ok ? 'stopped' : 'failed',
      startedAt,
      updatedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      output: sandboxRuntimeOutput(result.stdout, result.stderr, plan.mounts),
      redacted: true,
    },
  }
}
