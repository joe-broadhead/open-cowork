import { createManagedOpencodeServerAuth } from '@open-cowork/runtime-host'
import { createHash, randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import {
  assertCloudExecutionIsolationCapability,
  CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT,
  CloudExecutionCleanupDebtError,
  CloudExecutionIsolationError,
  DEFAULT_CLOUD_SANDBOX_RESOURCE_LIMITS,
  type CloudExecutionIsolationAttestation,
  type CloudExecutionIsolationCapability,
  type CloudExecutionIsolationProvider,
  type CloudExecutionProvisionInput,
  type CloudExecutionProvisionPreparation,
  type CloudIsolationControlBridge,
  type CloudSandboxIsolationProviderOptions,
} from './execution-isolation.ts'
import {
  createConnectedOpencodeCloudRuntimeAdapter,
  prepareOpencodeCloudRuntimeFiles,
} from './opencode-runtime-adapter.ts'
import { recordCloudMetric } from './observability.ts'
import {
  createDockerExecControlBridge,
  inspectStartedSandboxBoundary,
  resolveSandboxIsolationCapability,
  resolveSandboxRuntimeUser,
  SANDBOX_OPENCODE_PORT,
  validSandboxControlBridgeUrl,
} from './sandbox-docker-boundary.ts'
import {
  verifySandboxKnowledgeTransportReady,
  verifySandboxRuntimeV2PolicyReady,
  waitForSandboxRuntimeReady,
} from './sandbox-runtime-readiness.ts'
import {
  prepareSandboxExecutionEnvironment,
  removeSandboxPrivateRuntimePaths,
  resetSandboxPrivateRuntimePaths,
  SANDBOX_CONTAINER_WORKSPACE,
  sandboxPrivateRuntimeScopeKey,
} from './sandbox-execution-environment.ts'
import {
  sandboxWorkerOwnerHash,
  sweepSandboxWorkerOrphans,
} from './sandbox-orphan-cleanup.ts'
import { createSandboxWorkerOwnerLease } from './sandbox-worker-owner-lease.ts'
import {
  runSandboxRuntimeCommand,
  startSandboxRuntime,
  stopSandboxRuntime,
} from './runtime-portability.ts'

const CAPABILITY_CACHE_TTL_MS = 30_000
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

function redactedFailure(reasonCode: string) {
  return new CloudExecutionIsolationError(reasonCode)
}

function throwIfProvisionAborted(input: CloudExecutionProvisionInput) {
  if (!input.signal?.aborted) return
  throw input.signal.reason instanceof Error
    ? input.signal.reason
    : new DOMException('Runtime provisioning was aborted.', 'AbortError')
}

function boundaryId(input: CloudExecutionProvisionInput) {
  const scopeHash = createHash('sha256')
    .update(input.execution.tenantId)
    .update('\0')
    .update(input.execution.sessionId)
    .digest('hex')
    .slice(0, 16)
  return `oc-${scopeHash}-${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

async function recordBoundaryMetric(
  options: CloudSandboxIsolationProviderOptions,
  name: string,
  attributes: Record<string, string | number | boolean>,
) {
  await recordCloudMetric(options.observability, {
    name,
    value: 1,
    unit: '1',
    attributes: {
      provider: 'sandbox',
      ...attributes,
    },
  })
}

async function stopBoundaryWithRetry(
  plan: Parameters<typeof stopSandboxRuntime>[0],
  options: CloudSandboxIsolationProviderOptions,
) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await stopSandboxRuntime(plan, options.runner)
    if (result.ok) return
    if (attempt < 3) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 50))
    }
  }
  throw new CloudExecutionIsolationError(
    'sandbox_runtime_teardown_failed',
    'Cloud execution boundary teardown failed.',
  )
}

export function createSandboxCloudExecutionIsolationProvider(
  options: CloudSandboxIsolationProviderOptions,
): CloudExecutionIsolationProvider {
  type PendingCleanup = {
    plan: Parameters<typeof stopSandboxRuntime>[0] | null
    provisionInput: CloudExecutionProvisionInput
    privateRuntimeScope: string
    runtimeFiles: ReturnType<typeof prepareOpencodeCloudRuntimeFiles> | null
    controlBridge: CloudIsolationControlBridge | null
    workspaceMaskCleanup: (() => void) | null
    monitor: NodeJS.Timeout | null
    cleaned: boolean
    cleanupPromise: Promise<string | null> | null
  }
  type ProvisionReservation = {
    originalInput: CloudExecutionProvisionInput
    provisionInput: CloudExecutionProvisionInput
    providerCapability: CloudExecutionIsolationCapability
    runAsUser: string
    privateRuntimeScope: string
    state: 'prepared' | 'provisioning' | 'consumed'
    preparation: CloudExecutionProvisionPreparation
  }
  const workerOwner = sandboxWorkerOwnerHash(
    options.workerId,
    options.runtimeRootPath,
  )
  const leaseId = randomUUID().replaceAll('-', '')
  const ownerLease = options.ownerLease || createSandboxWorkerOwnerLease({
    runtimeRootPath: options.runtimeRootPath,
    workerOwner,
  })
  const activeBoundaries = new Set<PendingCleanup>()
  const pendingCleanup = new Set<PendingCleanup>()
  const cleanupCompletions = new WeakMap<PendingCleanup, {
    promise: Promise<void>
    resolve: () => void
  }>()
  const privateRuntimeAdmissions = new Set<string>()
  const provisionReservations = new Set<ProvisionReservation>()
  const provisionPreparationPromises = new WeakMap<
    CloudExecutionProvisionInput,
    Promise<ProvisionReservation>
  >()
  const cleanupPrivateRuntimePaths = options.cleanupPrivateRuntimePaths
    || ((input) => removeSandboxPrivateRuntimePaths(
      input,
      options.runtimeRootPath,
    ))
  let orphanCleanupTimer: NodeJS.Timeout | null = null
  let orphanCleanupPass: Promise<void> | null = null
  let providerClosePromise: Promise<void> | null = null
  let providerClosing = false
  let activeAdmissions = 0
  const admissionDrainWaiters = new Set<() => void>()
  let startupOrphanSweepComplete = false
  let startupOrphanSweep: Promise<{
    ok: boolean
    reasonCode: string
  }> | null = null
  let cachedCapability: Promise<CloudExecutionIsolationCapability> | null = null
  let capabilityExpiresAt = 0
  const cleanupCompletion = (pending: PendingCleanup) => {
    const existing = cleanupCompletions.get(pending)
    if (existing) return existing
    let resolveCleanup: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      resolveCleanup = resolve
    })
    const completion = { promise, resolve: resolveCleanup }
    cleanupCompletions.set(pending, completion)
    return completion
  }
  const resolveCleanupCompletion = (pending: PendingCleanup) => {
    const completion = cleanupCompletions.get(pending)
    if (!completion) return
    cleanupCompletions.delete(pending)
    completion.resolve()
  }
  const baseCapability = () => {
    if (!cachedCapability || capabilityExpiresAt <= Date.now()) {
      cachedCapability = resolveSandboxIsolationCapability(options)
      capabilityExpiresAt = Date.now() + CAPABILITY_CACHE_TTL_MS
    }
    return cachedCapability
  }
  const ensureStartupOrphansCleaned = () => {
    if (startupOrphanSweepComplete) {
      return Promise.resolve({
        ok: true,
        reasonCode: 'sandbox_startup_orphans_cleaned',
      })
    }
    if (!startupOrphanSweep) {
      startupOrphanSweep = (async () => {
        try {
          const ownerClaim = await ownerLease.claim()
          if (!ownerClaim.owned) {
            throw new CloudExecutionIsolationError(ownerClaim.reasonCode)
          }
          await sweepSandboxWorkerOrphans({
            options,
            workerOwner,
            leaseId,
          })
          startupOrphanSweepComplete = true
          await recordBoundaryMetric(
            options,
            'open_cowork_cloud_isolation_startup_orphan_cleanup_total',
            { status: 'ok' },
          )
          return {
            ok: true,
            reasonCode: 'sandbox_startup_orphans_cleaned',
          }
        } catch (error) {
          await recordBoundaryMetric(
            options,
            'open_cowork_cloud_isolation_startup_orphan_cleanup_total',
            {
              status: 'failed',
              reason: error instanceof CloudExecutionIsolationError
                ? error.reasonCode
                : 'sandbox_startup_orphan_cleanup_failed',
            },
          )
          startupOrphanSweep = null
          return {
            ok: false,
            reasonCode: error instanceof CloudExecutionIsolationError
              ? error.reasonCode
              : 'sandbox_startup_orphan_cleanup_failed',
          }
        }
      })()
    }
    return startupOrphanSweep
  }
  const evaluateCapability = async () => {
    const resolved = await baseCapability()
    if (!resolved.available || !resolved.verified) return resolved
    const sweep = await ensureStartupOrphansCleaned()
    if (!sweep.ok) {
      return {
        ...resolved,
        available: false,
        verified: false,
        reasonCode: sweep.reasonCode,
      }
    }
    if (pendingCleanup.size === 0) return resolved
    return {
      ...resolved,
      available: false,
      verified: false,
      reasonCode: 'sandbox_orphan_cleanup_pending',
    }
  }
  const beginAdmission = () => {
    if (providerClosing) {
      throw new CloudExecutionIsolationError('sandbox_provider_closing')
    }
    activeAdmissions += 1
    return () => {
      activeAdmissions = Math.max(0, activeAdmissions - 1)
      if (activeAdmissions === 0) {
        for (const resolveDrain of admissionDrainWaiters) resolveDrain()
        admissionDrainWaiters.clear()
      }
    }
  }
  const waitForAdmissionsToDrain = () => (
    activeAdmissions === 0
      ? Promise.resolve()
      : new Promise<void>((resolveDrain) => admissionDrainWaiters.add(resolveDrain))
  )
  const privateRuntimeScopeInUse = (privateRuntimeScope: string) => (
    privateRuntimeAdmissions.has(privateRuntimeScope)
    || Array.from(activeBoundaries).some(
      (boundary) => boundary.privateRuntimeScope === privateRuntimeScope,
    )
    || Array.from(pendingCleanup).some(
      (boundary) => boundary.privateRuntimeScope === privateRuntimeScope,
    )
  )
  const consumeProvisionReservation = (reservation: ProvisionReservation) => {
    if (reservation.state === 'consumed') return
    reservation.state = 'consumed'
    provisionReservations.delete(reservation)
    privateRuntimeAdmissions.delete(reservation.privateRuntimeScope)
    provisionPreparationPromises.delete(reservation.originalInput)
  }
  const releaseProvisionReservation = async (reservation: ProvisionReservation) => {
    if (reservation.state !== 'prepared') return
    try {
      cleanupPrivateRuntimePaths(reservation.provisionInput)
    } catch {
      throw redactedFailure('sandbox_private_runtime_cleanup_failed')
    }
    consumeProvisionReservation(reservation)
  }
  const createProvisionReservation = async (
    input: CloudExecutionProvisionInput,
  ): Promise<ProvisionReservation> => {
    throwIfProvisionAborted(input)
    const preparedInput = await options.prepareInput?.(input) || input
    throwIfProvisionAborted(input)
    const provisionInput = preparedInput === input
      ? input
      : { ...preparedInput, signal: input.signal }
    if (
      provisionInput.paths !== input.paths
      || provisionInput.execution.tenantId !== input.execution.tenantId
      || provisionInput.execution.sessionId !== input.execution.sessionId
    ) {
      throw redactedFailure('sandbox_prepare_input_scope_changed')
    }
    const providerCapability = await evaluateCapability()
    throwIfProvisionAborted(input)
    assertCloudExecutionIsolationCapability(options.policy, providerCapability)
    const runtimeUser = resolveSandboxRuntimeUser(options)
    if (!runtimeUser.runAsUser) {
      throw redactedFailure(runtimeUser.reasonCode)
    }
    const privateRuntimeScope = sandboxPrivateRuntimeScopeKey(
      provisionInput,
      options.runtimeRootPath,
    )
    if (privateRuntimeScopeInUse(privateRuntimeScope)) {
      throw redactedFailure('sandbox_private_runtime_path_in_use')
    }

    let reservation!: ProvisionReservation
    const preparation: CloudExecutionProvisionPreparation = {
      release: () => releaseProvisionReservation(reservation),
    }
    reservation = {
      originalInput: input,
      provisionInput,
      providerCapability,
      runAsUser: runtimeUser.runAsUser,
      privateRuntimeScope,
      state: 'prepared',
      preparation,
    }
    privateRuntimeAdmissions.add(privateRuntimeScope)
    provisionReservations.add(reservation)
    try {
      // This is intentionally before application checkpoint restore. It removes
      // crash-stale credentials and symlinks, then reserves the clean scope.
      resetSandboxPrivateRuntimePaths(provisionInput, options.runtimeRootPath)
      throwIfProvisionAborted(input)
    } catch (error) {
      try {
        await releaseProvisionReservation(reservation)
      } catch {
        throw redactedFailure('sandbox_private_runtime_cleanup_failed')
      }
      if (error instanceof CloudExecutionIsolationError) throw error
      throw redactedFailure('private_runtime_path_invalid')
    }
    return reservation
  }
  const getOrCreateProvisionReservation = (
    input: CloudExecutionProvisionInput,
  ) => {
    const existing = provisionPreparationPromises.get(input)
    if (existing) return existing
    const preparation = createProvisionReservation(input)
    provisionPreparationPromises.set(input, preparation)
    void preparation.catch(() => {
      if (provisionPreparationPromises.get(input) === preparation) {
        provisionPreparationPromises.delete(input)
      }
    })
    return preparation
  }
  const performCleanup = async (pending: PendingCleanup) => {
    if (pending.cleaned) return null
    let teardownFailed = false
    if (pending.monitor) {
      clearInterval(pending.monitor)
      pending.monitor = null
    }
    try {
      await pending.controlBridge?.close()
      pending.controlBridge = null
    } catch {
      teardownFailed = true
    }
    if (pending.plan) {
      try {
        await stopBoundaryWithRetry(pending.plan, options)
        pending.plan = null
      } catch {
        teardownFailed = true
      }
    }
    if (teardownFailed) return 'sandbox_runtime_teardown_failed'
    try {
      pending.workspaceMaskCleanup?.()
      pending.workspaceMaskCleanup = null
    } catch {
      return 'sandbox_workspace_mask_cleanup_failed'
    }
    try {
      pending.runtimeFiles?.cleanup()
      pending.runtimeFiles = null
      cleanupPrivateRuntimePaths(pending.provisionInput)
      pending.cleaned = true
      return null
    } catch {
      return 'sandbox_private_runtime_cleanup_failed'
    }
  }
  const attemptCleanup = (pending: PendingCleanup) => {
    if (!pending.cleanupPromise) {
      const cleanup = performCleanup(pending)
      pending.cleanupPromise = cleanup
      void cleanup.finally(() => {
        if (pending.cleanupPromise === cleanup) pending.cleanupPromise = null
      })
    }
    return pending.cleanupPromise
  }
  const runPendingCleanupPass = async () => {
    for (const pending of Array.from(pendingCleanup)) {
      const failure = await attemptCleanup(pending)
      if (!failure) {
        pendingCleanup.delete(pending)
        activeBoundaries.delete(pending)
        resolveCleanupCompletion(pending)
        await recordBoundaryMetric(
          options,
          'open_cowork_cloud_isolation_orphan_cleanup_total',
          { status: 'ok' },
        )
      } else {
        await recordBoundaryMetric(
          options,
          'open_cowork_cloud_isolation_orphan_cleanup_total',
          { status: 'failed', reason: failure },
        )
      }
    }
  }
  const runOwnedBoundaryCleanupPass = async () => {
    for (const cleanup of new Set([
      ...activeBoundaries,
      ...pendingCleanup,
    ])) {
      const failure = await attemptCleanup(cleanup)
      if (failure) {
        pendingCleanup.add(cleanup)
        await recordBoundaryMetric(
          options,
          'open_cowork_cloud_isolation_orphan_cleanup_total',
          { status: 'failed', reason: failure },
        )
        continue
      }
      activeBoundaries.delete(cleanup)
      pendingCleanup.delete(cleanup)
      resolveCleanupCompletion(cleanup)
      await recordBoundaryMetric(
        options,
        'open_cowork_cloud_isolation_orphan_cleanup_total',
        { status: 'ok' },
      )
    }
  }
  const scheduleOrphanCleanup = () => {
    if (
      providerClosing
      || orphanCleanupTimer
      || orphanCleanupPass
      || pendingCleanup.size === 0
    ) return
    orphanCleanupTimer = setTimeout(() => {
      orphanCleanupTimer = null
      orphanCleanupPass = runPendingCleanupPass()
        .finally(() => {
          orphanCleanupPass = null
          scheduleOrphanCleanup()
        })
    }, Math.max(10, options.orphanCleanupRetryMs || 10_000))
    orphanCleanupTimer.unref?.()
  }

  return {
    name: 'sandbox',
    async capability() {
      const endAdmission = beginAdmission()
      try {
        return await evaluateCapability()
      } finally {
        endAdmission()
      }
    },
    async prepareProvision(input) {
      const endAdmission = beginAdmission()
      let reservation: ProvisionReservation | null = null
      try {
        throwIfProvisionAborted(input)
        reservation = await getOrCreateProvisionReservation(input)
        throwIfProvisionAborted(input)
        if (reservation.state !== 'prepared') {
          throw redactedFailure('sandbox_private_runtime_path_in_use')
        }
        return reservation.preparation
      } catch (error) {
        if (reservation?.state === 'prepared') {
          await releaseProvisionReservation(reservation)
        }
        throw error
      } finally {
        endAdmission()
      }
    },
    close() {
      if (!providerClosePromise) {
        providerClosing = true
        const closeAttempt = (async () => {
          await waitForAdmissionsToDrain()
          if (orphanCleanupTimer) {
            clearTimeout(orphanCleanupTimer)
            orphanCleanupTimer = null
          }
          let cleanupPassFailed = false
          try {
            await orphanCleanupPass
            for (
              let attempt = 0;
              attempt < 3
                && (
                  activeBoundaries.size > 0
                  || pendingCleanup.size > 0
                  || provisionReservations.size > 0
                );
              attempt += 1
            ) {
              await runOwnedBoundaryCleanupPass()
              for (const reservation of Array.from(provisionReservations)) {
                try {
                  await releaseProvisionReservation(reservation)
                } catch {
                  // Retain the reservation and owner lease for the next pass.
                }
              }
              if (
                (
                  activeBoundaries.size > 0
                  || pendingCleanup.size > 0
                  || provisionReservations.size > 0
                )
                && attempt < 2
              ) {
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
              }
            }
          } catch {
            cleanupPassFailed = true
          }
          if (
            cleanupPassFailed
            || activeBoundaries.size > 0
            || pendingCleanup.size > 0
            || provisionReservations.size > 0
          ) {
            throw new CloudExecutionIsolationError(
              'sandbox_provider_cleanup_residue',
              'Cloud execution provider cleanup left residual boundaries.',
            )
          }
          try {
            await ownerLease.close()
          } catch {
            throw new CloudExecutionIsolationError(
              'sandbox_worker_owner_release_failed',
            )
          }
        })()
        providerClosePromise = closeAttempt
        void closeAttempt.catch(() => {
          // Cleanup debt retains the exclusive owner lease. Allow a later
          // idempotent retry after the boundary-level cleanup condition clears.
          if (providerClosePromise === closeAttempt) providerClosePromise = null
        })
      }
      return providerClosePromise
    },
    async provision(input) {
      const endAdmission = beginAdmission()
      let reservation: ProvisionReservation | null = null
      try {
        throwIfProvisionAborted(input)
        reservation = await getOrCreateProvisionReservation(input)
        throwIfProvisionAborted(input)
        if (reservation.state !== 'prepared') {
          throw redactedFailure('sandbox_private_runtime_path_in_use')
        }
        reservation.state = 'provisioning'
        const {
          privateRuntimeScope,
          providerCapability,
          provisionInput,
          runAsUser,
        } = reservation
        let plan: Awaited<ReturnType<typeof startSandboxRuntime>>['plan'] | null = null
        let envFile: string | null = null
        let runtimeFiles: ReturnType<typeof prepareOpencodeCloudRuntimeFiles> | null = null
        let controlBridge: CloudIsolationControlBridge | null = null
        let workspaceMaskCleanup: (() => void) | null = null
        let monitor: NodeJS.Timeout | null = null
        let closed = false
        let boundaryClosePromise: Promise<void> | null = null
        let cleanupState: PendingCleanup | null = null
        try {
        await recordBoundaryMetric(options, 'open_cowork_cloud_isolation_provision_total', {
          status: 'started',
        })
        throwIfProvisionAborted(provisionInput)
        const id = boundaryId(provisionInput)
        const auth = createManagedOpencodeServerAuth()
        const environment = prepareSandboxExecutionEnvironment(
          provisionInput,
          auth,
          options.runtimeAssetPaths || [],
          options.runtimeRootPath,
        )
        workspaceMaskCleanup = environment.cleanupWorkspaceMaskPlaceholders
        runtimeFiles = prepareOpencodeCloudRuntimeFiles(
          provisionInput.paths,
          environment.runtimeConfig,
        )
        envFile = environment.envFile
        const allowedSourceRoots = [
          ...environment.mounts.map((mount) => mount.source),
          envFile,
        ]
        const start = await startSandboxRuntime({
          engine: options.policy.engine!,
          imageComponentId: options.policy.imageComponentId!,
          componentManifest: options.policy.componentManifest,
          runtimeId: id,
          ownership: {
            workerOwner,
            leaseId,
          },
          mounts: environment.mounts,
          allowedSourceRoots,
          networkPolicy: options.policy.network,
          entrypoint: options.policy.opencodeCommand!,
          workingDirectory: SANDBOX_CONTAINER_WORKSPACE,
          environmentFile: envFile,
          runAsUser,
          readOnlyRootFilesystem: true,
          resourceLimits: options.resourceLimits
            || DEFAULT_CLOUD_SANDBOX_RESOURCE_LIMITS,
          command: [
            'serve',
            '--hostname=0.0.0.0',
            `--port=${SANDBOX_OPENCODE_PORT}`,
          ],
        }, options.runner)
        plan = start.plan
        throwIfProvisionAborted(provisionInput)
        workspaceMaskCleanup()
        workspaceMaskCleanup = null
        rmSync(envFile, { force: true })
        envFile = null
        if (!start.ok) throw redactedFailure(start.reasonCode)
        const boundaryVerified = await inspectStartedSandboxBoundary({
          options,
          boundaryId: id,
          mounts: start.plan.mounts,
          runAsUser,
          workerOwner,
          leaseId,
        })
        throwIfProvisionAborted(provisionInput)
        if (!boundaryVerified) {
          throw redactedFailure('sandbox_boundary_attestation_failed')
        }

        controlBridge = await (options.controlBridgeFactory || createDockerExecControlBridge)({
          boundaryId: id,
          containerPort: SANDBOX_OPENCODE_PORT,
        })
        throwIfProvisionAborted(provisionInput)
        if (!validSandboxControlBridgeUrl(controlBridge.url)) {
          throw redactedFailure('sandbox_control_bridge_invalid')
        }
        const url = controlBridge.url
        await waitForSandboxRuntimeReady({
          url,
          authorizationHeader: auth.authorizationHeader,
          timeoutMs: options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS,
        })
        throwIfProvisionAborted(provisionInput)
        await verifySandboxRuntimeV2PolicyReady({
          url,
          authorizationHeader: auth.authorizationHeader,
          runtimeConfig: environment.runtimeConfig,
        })
        throwIfProvisionAborted(provisionInput)
        await verifySandboxKnowledgeTransportReady({
          options,
          boundaryId: id,
          env: provisionInput.env,
        })
        throwIfProvisionAborted(provisionInput)

        cleanupState = {
          plan,
          provisionInput,
          privateRuntimeScope,
          runtimeFiles,
          controlBridge,
          workspaceMaskCleanup,
          monitor: null,
          cleaned: false,
          cleanupPromise: null,
        }
        const ownedCleanupState = cleanupState
        const adapter = await createConnectedOpencodeCloudRuntimeAdapter({
          url,
          auth,
          directory: SANDBOX_CONTAINER_WORKSPACE,
          config: environment.runtimeConfig,
          modelReadinessTimeoutMs: options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS,
          async closeServer() {
            if (monitor) {
              clearInterval(monitor)
              monitor = null
            }
            const failure = await attemptCleanup(ownedCleanupState)
            if (failure) {
              pendingCleanup.add(ownedCleanupState)
              scheduleOrphanCleanup()
              throw new CloudExecutionCleanupDebtError(
                failure,
                cleanupCompletion(ownedCleanupState).promise,
              )
            }
            activeBoundaries.delete(ownedCleanupState)
            pendingCleanup.delete(ownedCleanupState)
            resolveCleanupCompletion(ownedCleanupState)
          },
        })
        throwIfProvisionAborted(provisionInput)
        let monitoring = false
        monitor = setInterval(() => {
          if (monitoring || closed) return
          monitoring = true
          void runSandboxRuntimeCommand(
            'docker',
            ['inspect', '--format', '{{.State.Running}}', id],
            options.runner,
          ).then((result) => {
            if (result.exitCode !== 0 || result.stdout?.trim() !== 'true') {
              provisionInput.onUnexpectedExit?.()
            }
          }).finally(() => {
            monitoring = false
          })
        }, 2_000)
        monitor.unref?.()
        ownedCleanupState.monitor = monitor

        const attestation: CloudExecutionIsolationAttestation = {
          ...providerCapability,
          format: CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT,
          boundaryId: id,
          establishedAt: new Date().toISOString(),
        }
        await recordBoundaryMetric(options, 'open_cowork_cloud_isolation_provision_total', {
          status: 'ready',
        })
        // A sibling teardown can fail while this boundary is starting. Do not
        // admit a replacement after cleanup debt appears.
        if (pendingCleanup.size > 0) {
          throw redactedFailure('sandbox_orphan_cleanup_pending')
        }
        if (providerClosing) throw redactedFailure('sandbox_provider_closing')
        activeBoundaries.add(ownedCleanupState)
        return {
          adapter,
          attestation,
          async close() {
            if (closed) return
            if (!boundaryClosePromise) {
              boundaryClosePromise = (async () => {
                try {
                  await adapter.close?.()
                  closed = true
                  await recordBoundaryMetric(options, 'open_cowork_cloud_isolation_teardown_total', {
                    status: 'ok',
                  })
                } catch (error) {
                  await recordBoundaryMetric(options, 'open_cowork_cloud_isolation_teardown_total', {
                    status: 'failed',
                    reason: error instanceof CloudExecutionIsolationError
                      ? error.reasonCode
                      : 'unknown',
                  })
                  throw error
                }
              })()
            }
            try {
              await boundaryClosePromise
            } catch (error) {
              boundaryClosePromise = null
              throw error
            }
          },
        }
        } catch (error) {
        if (monitor) clearInterval(monitor)
        if (envFile) rmSync(envFile, { force: true })
        if (error instanceof CloudExecutionCleanupDebtError) {
          await recordBoundaryMetric(options, 'open_cowork_cloud_isolation_provision_total', {
            status: 'failed',
            reason: error.reasonCode,
          })
          throw error
        }
        const failedCleanupState = cleanupState || {
          plan,
          provisionInput,
          privateRuntimeScope,
          runtimeFiles,
          controlBridge,
          workspaceMaskCleanup,
          monitor,
          cleaned: false,
          cleanupPromise: null,
        }
        const cleanupFailure = await attemptCleanup(failedCleanupState)
        const cleanupDebt = cleanupFailure
          ? cleanupCompletion(failedCleanupState)
          : null
        if (cleanupFailure) {
          pendingCleanup.add(failedCleanupState)
          scheduleOrphanCleanup()
        } else {
          activeBoundaries.delete(failedCleanupState)
          pendingCleanup.delete(failedCleanupState)
          resolveCleanupCompletion(failedCleanupState)
        }
        await recordBoundaryMetric(options, 'open_cowork_cloud_isolation_provision_total', {
          status: 'failed',
          reason: cleanupFailure
            || (error instanceof CloudExecutionIsolationError ? error.reasonCode : 'unknown'),
        })
        if (cleanupFailure) {
          throw new CloudExecutionCleanupDebtError(
            cleanupFailure,
            cleanupDebt!.promise,
          )
        }
        if (error instanceof CloudExecutionIsolationError) throw error
          throw redactedFailure('sandbox_runtime_provision_failed')
        }
      } finally {
        try {
          if (reservation?.state === 'prepared') {
            await releaseProvisionReservation(reservation)
          } else if (reservation) {
            consumeProvisionReservation(reservation)
          }
        } finally {
          endAdmission()
        }
      }
    },
  }
}
