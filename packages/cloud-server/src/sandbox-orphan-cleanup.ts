import { createHash, randomBytes } from 'node:crypto'
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  isAbsolute,
  relative,
  resolve,
} from 'node:path'
import {
  CloudExecutionIsolationError,
  type CloudSandboxIsolationProviderOptions,
} from './execution-isolation.ts'
import {
  runSandboxRuntimeCommand,
  SANDBOX_RUNTIME_LABEL,
  SANDBOX_RUNTIME_LEASE_LABEL,
  SANDBOX_RUNTIME_OWNER_LABEL,
} from './runtime-portability.ts'

const PRIVATE_RUNTIME_DESTINATIONS = new Set([
  '/runtime-home/home',
  '/runtime-home/xdg/config',
  '/runtime-home/xdg/data',
  '/runtime-home/xdg/state',
  '/runtime-home/xdg/cache',
])
const MAX_OWNED_ORPHANS_PER_SWEEP = 1_000
const SANDBOX_RUNTIME_ROOT_ID_FILE = '.open-cowork-sandbox-root-id'

type DockerOrphanInspection = {
  Id?: unknown
  State?: { Running?: unknown }
  Config?: { Labels?: unknown }
  Mounts?: unknown
}

export function canonicalSandboxRuntimeRoot(runtimeRootPath: string) {
  const resolvedRoot = resolve(runtimeRootPath)
  mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 })
  const canonicalRoot = realpathSync(resolvedRoot)
  const stat = lstatSync(canonicalRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CloudExecutionIsolationError('sandbox_runtime_root_invalid')
  }
  return canonicalRoot
}

function sandboxRuntimeRootIdentity(runtimeRootPath: string) {
  const canonicalRoot = canonicalSandboxRuntimeRoot(runtimeRootPath)
  const identityPath = resolve(canonicalRoot, SANDBOX_RUNTIME_ROOT_ID_FILE)
  const temporaryPath = resolve(
    canonicalRoot,
    `.${SANDBOX_RUNTIME_ROOT_ID_FILE}.${process.pid}.${randomBytes(8).toString('hex')}`,
  )
  const removeTemporaryIdentity = () => {
    try {
      unlinkSync(temporaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    const candidate = randomBytes(16).toString('hex')
    writeFileSync(temporaryPath, `${candidate}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    try {
      linkSync(temporaryPath, identityPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } catch (error) {
    removeTemporaryIdentity()
    throw error
  }
  removeTemporaryIdentity()
  const stat = lstatSync(identityPath)
  const identity = readFileSync(identityPath, 'utf8').trim()
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0
    || !/^[a-f0-9]{32}$/.test(identity)
  ) {
    throw new CloudExecutionIsolationError('sandbox_runtime_root_identity_invalid')
  }
  return {
    canonicalRoot,
    identity,
  }
}

export function sandboxWorkerOwnerHash(workerId: string, runtimeRootPath: string) {
  const normalized = workerId.trim()
  if (!normalized) {
    throw new CloudExecutionIsolationError('sandbox_worker_id_missing')
  }
  const root = sandboxRuntimeRootIdentity(runtimeRootPath)
  return createHash('sha256')
    .update(root.canonicalRoot)
    .update('\0')
    .update(root.identity)
    .update('\0')
    .update(normalized)
    .digest('hex')
    .slice(0, 32)
}

function pathInside(root: string, candidate: string) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function verifiedPrivateRuntimeRoots(
  inspection: DockerOrphanInspection,
  configuredRuntimeRoot: string,
) {
  if (!Array.isArray(inspection.Mounts)) {
    throw new CloudExecutionIsolationError('sandbox_orphan_mounts_unverified')
  }
  const configuredRoot = resolve(configuredRuntimeRoot)
  const realConfiguredRoot = realpathSync(configuredRoot)
  const roots = new Map<string, string>()
  for (const raw of inspection.Mounts) {
    if (!raw || typeof raw !== 'object') {
      throw new CloudExecutionIsolationError('sandbox_orphan_mounts_unverified')
    }
    const mount = raw as Record<string, unknown>
    if (!PRIVATE_RUNTIME_DESTINATIONS.has(String(mount.Destination))) continue
    if (
      mount.Type !== 'bind'
      || typeof mount.Source !== 'string'
      || roots.has(String(mount.Destination))
    ) {
      throw new CloudExecutionIsolationError('sandbox_orphan_mounts_unverified')
    }
    const source = resolve(mount.Source)
    const stat = lstatSync(source)
    const realSource = realpathSync(source)
    if (
      source === configuredRoot
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || !pathInside(configuredRoot, source)
      || !pathInside(realConfiguredRoot, realSource)
    ) {
      throw new CloudExecutionIsolationError('sandbox_orphan_mounts_unverified')
    }
    roots.set(String(mount.Destination), source)
  }
  if (roots.size !== PRIVATE_RUNTIME_DESTINATIONS.size) {
    throw new CloudExecutionIsolationError('sandbox_orphan_mounts_unverified')
  }
  return Array.from(new Set(roots.values()))
    .sort((left, right) => right.length - left.length)
}

function parseInspection(
  stdout: string | undefined,
  expectedId: string,
  workerOwner: string,
  leaseId: string,
  runtimeRootPath: string,
) {
  let inspection: DockerOrphanInspection
  try {
    inspection = JSON.parse(stdout || '') as DockerOrphanInspection
  } catch {
    throw new CloudExecutionIsolationError('sandbox_orphan_inspection_failed')
  }
  const labels = inspection.Config?.Labels
  if (
    !labels
    || typeof labels !== 'object'
    || inspection.Id !== expectedId
    || inspection.State?.Running !== true
    || (labels as Record<string, unknown>)[SANDBOX_RUNTIME_LABEL] !== 'true'
    || (labels as Record<string, unknown>)[SANDBOX_RUNTIME_OWNER_LABEL] !== workerOwner
  ) {
    throw new CloudExecutionIsolationError('sandbox_orphan_inspection_failed')
  }
  const ownerLease = (labels as Record<string, unknown>)[SANDBOX_RUNTIME_LEASE_LABEL]
  if (typeof ownerLease !== 'string' || !/^[a-f0-9]{32}$/.test(ownerLease)) {
    throw new CloudExecutionIsolationError('sandbox_orphan_inspection_failed')
  }
  if (ownerLease === leaseId) return null
  return {
    id: expectedId,
    roots: verifiedPrivateRuntimeRoots(inspection, runtimeRootPath),
  }
}

function removeVerifiedRoots(configuredRuntimeRoot: string, roots: readonly string[]) {
  const configuredRoot = resolve(configuredRuntimeRoot)
  const realConfiguredRoot = realpathSync(configuredRoot)
  for (const rawRoot of roots) {
    const root = resolve(rawRoot)
    const stat = lstatSync(root)
    const realRoot = realpathSync(root)
    if (
      root === configuredRoot
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || !pathInside(configuredRoot, root)
      || !pathInside(realConfiguredRoot, realRoot)
    ) {
      throw new CloudExecutionIsolationError('sandbox_orphan_mounts_unverified')
    }
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  }
}

export async function sweepSandboxWorkerOrphans(input: {
  options: CloudSandboxIsolationProviderOptions
  workerOwner: string
  leaseId: string
}) {
  const list = await runSandboxRuntimeCommand(
    'docker',
    [
      'ps',
      '--filter',
      `label=${SANDBOX_RUNTIME_LABEL}=true`,
      '--filter',
      `label=${SANDBOX_RUNTIME_OWNER_LABEL}=${input.workerOwner}`,
      '--format',
      '{{.ID}}',
      '--no-trunc',
    ],
    input.options.runner,
  )
  if (list.exitCode !== 0) {
    throw new CloudExecutionIsolationError('sandbox_orphan_discovery_failed')
  }
  const ids = Array.from(new Set(
    (list.stdout || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
  ))
  if (
    ids.length > MAX_OWNED_ORPHANS_PER_SWEEP
    || ids.some((id) => !/^[a-f0-9]{64}$/i.test(id))
  ) {
    throw new CloudExecutionIsolationError('sandbox_orphan_discovery_failed')
  }
  const orphans: Array<{ id: string, roots: string[] }> = []
  for (const id of ids) {
    const result = await runSandboxRuntimeCommand(
      'docker',
      ['inspect', '--format', '{{json .}}', id],
      input.options.runner,
    )
    if (result.exitCode !== 0) {
      throw new CloudExecutionIsolationError('sandbox_orphan_inspection_failed')
    }
    const orphan = parseInspection(
      result.stdout,
      id,
      input.workerOwner,
      input.leaseId,
      input.options.runtimeRootPath,
    )
    if (orphan) orphans.push(orphan)
  }
  for (const orphan of orphans) {
    const removed = await runSandboxRuntimeCommand(
      'docker',
      ['rm', '--force', orphan.id],
      input.options.runner,
    )
    if (removed.exitCode !== 0) {
      throw new CloudExecutionIsolationError('sandbox_orphan_teardown_failed')
    }
    const stillExists = await runSandboxRuntimeCommand(
      'docker',
      ['inspect', '--format', '{{.Id}}', orphan.id],
      input.options.runner,
    )
    if (stillExists.exitCode === 0) {
      throw new CloudExecutionIsolationError('sandbox_orphan_teardown_failed')
    }
    removeVerifiedRoots(input.options.runtimeRootPath, orphan.roots)
  }
  return orphans.length
}
