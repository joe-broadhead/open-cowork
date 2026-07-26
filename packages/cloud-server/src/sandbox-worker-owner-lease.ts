import {
  lstatSync,
  mkdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import {
  createConnection,
  createServer,
  type Server,
} from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CloudExecutionIsolationError,
  type SandboxWorkerOwnerLease,
} from './execution-isolation.ts'
import { canonicalSandboxRuntimeRoot } from './sandbox-orphan-cleanup.ts'

const OWNER_LEASE_DIRECTORY_PREFIX = '.ocw'
const UNIX_SOCKET_PATH_MAX_BYTES = 100
const CLAIM_LOCK_ATTEMPTS = 20
const CLAIM_LOCK_RETRY_MS = 25
const OWNER_PROBE_TIMEOUT_MS = 500

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function errno(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code
}

function assertLeaseDirectory(path: string, requirePrivate = false) {
  const stat = lstatSync(path)
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (requirePrivate && (stat.mode & 0o077) !== 0)
    || (
      requirePrivate
      && typeof process.getuid === 'function'
      && stat.uid !== process.getuid()
    )
  ) {
    throw new CloudExecutionIsolationError('sandbox_worker_owner_lease_invalid')
  }
}

function socketExists(path: string) {
  try {
    const stat = lstatSync(path)
    if (!stat.isSocket() || stat.isSymbolicLink()) {
      throw new CloudExecutionIsolationError('sandbox_worker_owner_lease_invalid')
    }
    return true
  } catch (error) {
    if (errno(error) === 'ENOENT') return false
    throw error
  }
}

function unlinkVerifiedSocket(path: string) {
  if (!socketExists(path)) return
  unlinkSync(path)
}

async function acquireClaimLock(path: string) {
  for (let attempt = 0; attempt < CLAIM_LOCK_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 })
      return
    } catch (error) {
      if (errno(error) !== 'EEXIST') {
        throw new CloudExecutionIsolationError('sandbox_worker_owner_claim_failed')
      }
      if (attempt + 1 < CLAIM_LOCK_ATTEMPTS) {
        await delay(CLAIM_LOCK_RETRY_MS)
      }
    }
  }
  throw new CloudExecutionIsolationError('sandbox_worker_owner_claim_failed')
}

function releaseClaimLock(path: string) {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CloudExecutionIsolationError('sandbox_worker_owner_claim_failed')
    }
    rmdirSync(path)
  } catch (error) {
    if (errno(error) === 'ENOENT') return
    throw error
  }
}

function probeLiveOwner(path: string) {
  if (!socketExists(path)) return Promise.resolve(false)
  return new Promise<boolean>((resolveProbe, rejectProbe) => {
    const connection = createConnection(path)
    let settled = false
    const settle = (result: boolean, error?: unknown) => {
      if (settled) return
      settled = true
      connection.destroy()
      if (error) rejectProbe(error)
      else resolveProbe(result)
    }
    connection.setTimeout(OWNER_PROBE_TIMEOUT_MS)
    connection.once('connect', () => settle(true))
    connection.once('timeout', () => settle(true))
    connection.once('error', (error) => {
      if (errno(error) === 'ECONNREFUSED' || errno(error) === 'ENOENT') {
        settle(false)
      } else {
        settle(false, new CloudExecutionIsolationError(
          'sandbox_worker_owner_probe_failed',
        ))
      }
    })
  })
}

function listen(server: Server, path: string) {
  return new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: unknown) => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(path)
  })
}

function closeServer(server: Server) {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error && errno(error) !== 'ERR_SERVER_NOT_RUNNING') rejectClose(error)
      else resolveClose()
    })
  })
}

export function createSandboxWorkerOwnerLease(input: {
  runtimeRootPath: string
  workerOwner: string
}): SandboxWorkerOwnerLease {
  canonicalSandboxRuntimeRoot(input.runtimeRootPath)
  const canonicalTemporaryRoot = realpathSync(tmpdir())
  assertLeaseDirectory(canonicalTemporaryRoot)
  const ownerId = typeof process.getuid === 'function'
    ? String(process.getuid())
    : 'portable'
  const leaseDirectory = join(
    canonicalTemporaryRoot,
    `${OWNER_LEASE_DIRECTORY_PREFIX}-${ownerId}`,
  )
  mkdirSync(leaseDirectory, { recursive: true, mode: 0o700 })
  assertLeaseDirectory(leaseDirectory, true)
  const socketPath = join(leaseDirectory, `${input.workerOwner.slice(0, 16)}.s`)
  const claimLockPath = join(leaseDirectory, `${input.workerOwner.slice(0, 16)}.c`)
  if (
    Buffer.byteLength(socketPath) > UNIX_SOCKET_PATH_MAX_BYTES
    || Buffer.byteLength(claimLockPath) > UNIX_SOCKET_PATH_MAX_BYTES
  ) {
    throw new CloudExecutionIsolationError('sandbox_worker_owner_socket_path_invalid')
  }

  let server: Server | null = null
  let owned = false
  let claimPromise: Promise<{
    owned: boolean
    reasonCode: string
  }> | null = null

  const claim = async () => {
    if (owned) {
      return {
        owned: true,
        reasonCode: 'sandbox_worker_owner_claimed',
      }
    }
    await acquireClaimLock(claimLockPath)
    try {
      assertLeaseDirectory(leaseDirectory)
      if (await probeLiveOwner(socketPath)) {
        return {
          owned: false,
          reasonCode: 'sandbox_worker_owner_active',
        }
      }
      unlinkVerifiedSocket(socketPath)
      const nextServer = createServer((connection) => connection.end())
      try {
        await listen(nextServer, socketPath)
      } catch {
        nextServer.close()
        return {
          owned: false,
          reasonCode: 'sandbox_worker_owner_active',
        }
      }
      nextServer.unref()
      server = nextServer
      owned = true
      return {
        owned: true,
        reasonCode: 'sandbox_worker_owner_claimed',
      }
    } finally {
      releaseClaimLock(claimLockPath)
    }
  }

  return {
    claim() {
      if (!claimPromise) {
        claimPromise = claim().finally(() => {
          claimPromise = null
        })
      }
      return claimPromise
    },
    async close() {
      const activeServer = server
      if (!activeServer || !owned) return
      await acquireClaimLock(claimLockPath)
      try {
        await closeServer(activeServer)
        server = null
        owned = false
        unlinkVerifiedSocket(socketPath)
      } finally {
        releaseClaimLock(claimLockPath)
      }
    },
  }
}
