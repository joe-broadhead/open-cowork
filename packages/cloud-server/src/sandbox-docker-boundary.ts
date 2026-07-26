import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  CloudExecutionIsolationError,
  type CloudExecutionIsolationCapability,
  type CloudIsolationControlBridge,
  type CloudSandboxIsolationProviderOptions,
} from './execution-isolation.ts'
import {
  checkSandboxRuntimeEngine,
  runSandboxRuntimeCommand,
  SANDBOX_RUNTIME_ID_LABEL,
  SANDBOX_RUNTIME_LABEL,
  SANDBOX_RUNTIME_LEASE_LABEL,
  SANDBOX_RUNTIME_OWNER_LABEL,
  type SandboxMountPolicy,
} from './runtime-portability.ts'
import { SANDBOX_CONTAINER_WORKSPACE } from './sandbox-execution-environment.ts'

export const SANDBOX_OPENCODE_PORT = 4096

const NETWORK_POLICY_LABEL = 'open-cowork.egress_policy'
const NETWORK_ISOLATION_LABEL = 'open-cowork.isolation'
const CONTAINER_NODE = '/usr/local/bin/node'
const MAX_CONTROL_BRIDGE_CLIENTS = 64
const DOCKER_EXEC_TCP_BRIDGE = `
import net from 'node:net'
const socket = net.connect(Number(process.argv[1]), '127.0.0.1')
process.stdin.pipe(socket)
socket.pipe(process.stdout)
socket.on('error', () => process.exit(1))
`

function redactedFailure(reasonCode: string) {
  return new CloudExecutionIsolationError(reasonCode)
}

export async function createDockerExecControlBridge(input: {
  boundaryId: string
  containerPort: number
}): Promise<CloudIsolationControlBridge> {
  const clients = new Set<import('node:net').Socket>()
  const children = new Set<ChildProcessByStdio<Writable, Readable, null>>()
  const server: Server = createServer((client) => {
    if (clients.size >= MAX_CONTROL_BRIDGE_CLIENTS) {
      client.destroy()
      return
    }
    clients.add(client)
    client.setNoDelay(true)
    const child = spawn('docker', [
      'exec',
      '-i',
      input.boundaryId,
      CONTAINER_NODE,
      '--input-type=module',
      '--eval',
      DOCKER_EXEC_TCP_BRIDGE,
      String(input.containerPort),
    ], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    children.add(child)
    client.pipe(child.stdin)
    child.stdout.pipe(client)
    const close = () => {
      clients.delete(client)
      children.delete(child)
      client.destroy()
      child.stdin.destroy()
      child.stdout.destroy()
      if (!child.killed) child.kill()
    }
    client.on('error', close)
    client.on('close', close)
    child.on('error', close)
    child.on('close', close)
    child.stdin.on('error', close)
    child.stdout.on('error', close)
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw redactedFailure('sandbox_control_bridge_unavailable')
  }
  let closed = false
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return
      closed = true
      for (const client of clients) client.destroy()
      for (const child of children) {
        child.stdin.destroy()
        child.stdout.destroy()
        if (!child.killed) child.kill()
      }
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

export function validSandboxControlBridgeUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
      && Boolean(url.port)
      && url.pathname === '/'
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

export async function inspectRestrictedNetwork(
  options: CloudSandboxIsolationProviderOptions,
) {
  const network = options.policy.network
  if (network.kind !== 'restricted') return true
  const result = await runSandboxRuntimeCommand(
    'docker',
    [
      'network',
      'inspect',
      '--format',
      '{{json .}}',
      network.networkName,
    ],
    options.runner,
  )
  if (result.exitCode !== 0 || !result.stdout) return false
  let inspection: {
    Internal?: unknown
    Labels?: unknown
  }
  try {
    inspection = JSON.parse(result.stdout) as typeof inspection
  } catch {
    return false
  }
  const labels = inspection.Labels && typeof inspection.Labels === 'object'
    ? inspection.Labels as Record<string, unknown>
    : {}
  // Labels identify the operator-owned policy, while Internal is the Docker
  // enforcement property that removes the default external route. Explicitly
  // allowed APIs must be attached to this network or reached through a proxy
  // attached to it; labels alone never establish an egress boundary.
  return inspection.Internal === true
    && labels[NETWORK_ISOLATION_LABEL] === 'true'
    && labels[NETWORK_POLICY_LABEL] === network.policyId
}

async function inspectPinnedRuntimeImage(
  options: CloudSandboxIsolationProviderOptions,
) {
  const component = options.policy.componentManifest?.components.find(
    (entry) => entry.id === options.policy.imageComponentId,
  )
  const expectedDigest = component?.sha256?.toLowerCase().replace(/^sha256:/, '')
  const image = component?.source.replace(/^docker:\/\//, '').trim()
  const directImageId = image?.toLowerCase() === `sha256:${expectedDigest}`
  if (
    !expectedDigest
    || !image
    || (!directImageId && !image.includes(`@sha256:${expectedDigest}`))
  ) return null
  const result = await runSandboxRuntimeCommand(
    'docker',
    ['image', 'inspect', '--format', '{{.Id}}|{{join .RepoDigests ","}}', image],
    options.runner,
  )
  if (result.exitCode !== 0) return null
  const evidence = result.stdout?.toLowerCase() || ''
  const imageId = evidence.split('|')[0]?.trim()
  if (!imageId || !/^sha256:[a-f0-9]{64}$/.test(imageId)) return null
  if (
    imageId !== `sha256:${expectedDigest}`
    && !evidence.includes(`sha256:${expectedDigest}`)
  ) return null
  return { image, imageId }
}

type DockerBoundaryInspection = {
  Id?: unknown
  Name?: unknown
  Image?: unknown
  State?: { Running?: unknown }
  Config?: {
    Image?: unknown
    User?: unknown
    WorkingDir?: unknown
    Entrypoint?: unknown
    Cmd?: unknown
    Labels?: unknown
  }
  HostConfig?: {
    NetworkMode?: unknown
    AutoRemove?: unknown
    Privileged?: unknown
    ReadonlyRootfs?: unknown
    CapAdd?: unknown
    CapDrop?: unknown
    SecurityOpt?: unknown
    Init?: unknown
    Memory?: unknown
    NanoCpus?: unknown
    PidsLimit?: unknown
    RestartPolicy?: { Name?: unknown }
    Tmpfs?: unknown
  }
  Mounts?: unknown
  NetworkSettings?: { Networks?: unknown }
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function boundaryMountsMatch(
  inspection: DockerBoundaryInspection,
  expected: readonly SandboxMountPolicy[],
) {
  if (!Array.isArray(inspection.Mounts) || inspection.Mounts.length !== expected.length) {
    return false
  }
  const actual = new Map<string, { source: string, readWrite: boolean }>()
  for (const raw of inspection.Mounts) {
    if (!raw || typeof raw !== 'object') return false
    const mount = raw as Record<string, unknown>
    if (
      mount.Type !== 'bind'
      || typeof mount.Source !== 'string'
      || typeof mount.Destination !== 'string'
      || typeof mount.RW !== 'boolean'
      || actual.has(mount.Destination)
    ) return false
    actual.set(mount.Destination, {
      source: resolve(mount.Source),
      readWrite: mount.RW,
    })
  }
  return expected.every((mount) => {
    const actualMount = actual.get(mount.target)
    return actualMount?.source === resolve(mount.source)
      && actualMount.readWrite === (mount.mode === 'read-write')
  })
}

async function inspectStartedBoundary(input: {
  options: CloudSandboxIsolationProviderOptions
  boundaryId: string
  image: string
  imageId: string
  mounts: readonly SandboxMountPolicy[]
  runAsUser: string
  opencodeCommand: string
  workerOwner: string
  leaseId: string
}) {
  const result = await runSandboxRuntimeCommand(
    'docker',
    ['inspect', '--format', '{{json .}}', input.boundaryId],
    input.options.runner,
  )
  if (result.exitCode !== 0 || !result.stdout) return false
  let inspection: DockerBoundaryInspection
  try {
    inspection = JSON.parse(result.stdout) as DockerBoundaryInspection
  } catch {
    return false
  }
  const host = inspection.HostConfig
  const config = inspection.Config
  const labels = config?.Labels && typeof config.Labels === 'object'
    ? config.Labels as Record<string, unknown>
    : {}
  const networks = inspection.NetworkSettings?.Networks
    && typeof inspection.NetworkSettings.Networks === 'object'
    ? Object.keys(inspection.NetworkSettings.Networks)
    : []
  const expectedNetwork = input.options.policy.network.kind === 'restricted'
    ? input.options.policy.network.networkName
    : 'none'
  const tmpfs = host?.Tmpfs && typeof host.Tmpfs === 'object'
    ? (host.Tmpfs as Record<string, unknown>)['/tmp']
    : null
  const tmpfsOptions = typeof tmpfs === 'string' ? new Set(tmpfs.split(',')) : new Set<string>()
  return (
    typeof inspection.Id === 'string'
    && /^[a-f0-9]{64}$/.test(inspection.Id)
    && input.boundaryId === inspection.Name?.toString().replace(/^\//, '')
    && inspection.State?.Running === true
    && inspection.Image === input.imageId
    && config?.Image === input.image
    && config.User === input.runAsUser
    && config.WorkingDir === SANDBOX_CONTAINER_WORKSPACE
    && stringArray(config.Entrypoint).length === 1
    && stringArray(config.Entrypoint)[0] === input.opencodeCommand
    && JSON.stringify(stringArray(config.Cmd)) === JSON.stringify([
      'serve',
      '--hostname=0.0.0.0',
      `--port=${SANDBOX_OPENCODE_PORT}`,
    ])
    && labels[SANDBOX_RUNTIME_LABEL] === 'true'
    && labels[SANDBOX_RUNTIME_ID_LABEL] === input.boundaryId
    && labels[SANDBOX_RUNTIME_OWNER_LABEL] === input.workerOwner
    && labels[SANDBOX_RUNTIME_LEASE_LABEL] === input.leaseId
    && host?.NetworkMode === expectedNetwork
    && networks.length === 1
    && networks[0] === expectedNetwork
    && host.AutoRemove === true
    && host.Privileged === false
    && host.ReadonlyRootfs === true
    && stringArray(host.CapAdd).length === 0
    && stringArray(host.CapDrop).map((entry) => entry.toUpperCase()).includes('ALL')
    && stringArray(host.SecurityOpt).includes('no-new-privileges')
    && host.Init === true
    && host.Memory === 2 * 1024 * 1024 * 1024
    && host.NanoCpus === 2_000_000_000
    && host.PidsLimit === 512
    && host.RestartPolicy?.Name === 'no'
    && tmpfsOptions.has('rw')
    && tmpfsOptions.has('nosuid')
    && tmpfsOptions.has('nodev')
    && tmpfsOptions.has('size=268435456')
    && boundaryMountsMatch(inspection, input.mounts)
  )
}

export async function inspectStartedSandboxBoundary(input: {
  options: CloudSandboxIsolationProviderOptions
  boundaryId: string
  mounts: readonly SandboxMountPolicy[]
  runAsUser: string
  workerOwner: string
  leaseId: string
}) {
  const imageEvidence = await inspectPinnedRuntimeImage(input.options)
  const networkVerified = await inspectRestrictedNetwork(input.options)
  return Boolean(imageEvidence && networkVerified && await inspectStartedBoundary({
    ...input,
    ...imageEvidence,
    opencodeCommand: input.options.policy.opencodeCommand!,
  }))
}

export function resolveSandboxRuntimeUser(
  options: CloudSandboxIsolationProviderOptions,
) {
  const identity = options.runtimeIdentity || {
    uid: typeof process.getuid === 'function' ? process.getuid() : 1_000,
    gid: typeof process.getgid === 'function' ? process.getgid() : 1_000,
  }
  if (
    !Number.isSafeInteger(identity.uid)
    || !Number.isSafeInteger(identity.gid)
    || identity.uid <= 0
    || identity.gid <= 0
  ) {
    return {
      runAsUser: null,
      reasonCode: 'sandbox_runtime_user_not_non_root',
    } as const
  }
  return {
    runAsUser: `${identity.uid}:${identity.gid}`,
    reasonCode: 'sandbox_runtime_user_verified',
  } as const
}

export async function resolveSandboxIsolationCapability(
  options: CloudSandboxIsolationProviderOptions,
): Promise<CloudExecutionIsolationCapability> {
  const policyBlocker = options.policy.blockers[0]
  if (policyBlocker || !options.policy.engine) {
    return {
      provider: 'sandbox',
      available: false,
      verified: false,
      engine: options.policy.engine || 'external',
      processIsolation: 'external-boundary',
      userIsolation: 'external-identity',
      mountScope: 'unverified',
      runtimeHomeScope: 'unverified',
      descendantCleanup: 'provider-owned',
      networkPolicy: options.policy.network.kind,
      reasonCode: policyBlocker || 'sandbox_engine_missing',
    }
  }
  const runtimeUser = resolveSandboxRuntimeUser(options)
  if (!runtimeUser.runAsUser) {
    return {
      provider: 'sandbox',
      available: false,
      verified: false,
      engine: options.policy.engine,
      processIsolation: 'container',
      userIsolation: 'container-user',
      mountScope: 'unverified',
      runtimeHomeScope: 'unverified',
      descendantCleanup: 'container-init',
      networkPolicy: options.policy.network.kind,
      reasonCode: runtimeUser.reasonCode,
    }
  }
  const engine = await checkSandboxRuntimeEngine(options.policy.engine, options.runner)
  const imageVerified = engine.ok && Boolean(await inspectPinnedRuntimeImage(options))
  const networkVerified = imageVerified && await inspectRestrictedNetwork(options)
  const available = engine.ok && imageVerified && networkVerified
  return {
    provider: 'sandbox',
    available,
    verified: available,
    engine: options.policy.engine,
    processIsolation: 'container',
    userIsolation: 'container-user',
    mountScope: 'execution',
    runtimeHomeScope: 'execution',
    descendantCleanup: 'container-init',
    networkPolicy: options.policy.network.kind,
    reasonCode: !engine.ok
      ? engine.reasonCode
      : !imageVerified
        ? 'sandbox_runtime_image_unverified'
        : !networkVerified
          ? 'sandbox_network_policy_unverified'
          : 'sandbox_capability_verified',
  }
}
