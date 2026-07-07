import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanupSmokePaths,
  createSmokePaths,
  launchPackagedLinuxProbe,
  launchPackagedMacProbe,
  launchPackagedWindowsProbe,
  launchSmokeSession,
  type SmokeSession,
} from './smoke-helpers.ts'

const packagedExecutablePath = process.env.OPEN_COWORK_PACKAGED_EXECUTABLE?.trim()
const packagedTimeoutMs = 180_000
const packagedLaunchTimeoutMs = 90_000
const packagedIpcTimeoutMs = 60_000

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

test(
  'packaged app exposes preload surface and read-only settings/update contracts',
  {
    timeout: packagedTimeoutMs,
    skip: packagedExecutablePath
      ? false
      : 'OPEN_COWORK_PACKAGED_EXECUTABLE is not set; build/package first to run packaged smoke',
  },
  async () => {
    const executablePath = packagedExecutablePath
    assert.ok(
      executablePath,
      'OPEN_COWORK_PACKAGED_EXECUTABLE must point at a packaged desktop executable',
    )

    const paths = createSmokePaths()
    let session: SmokeSession | null = null

    try {
      const launchPackagedProbe = process.platform === 'darwin'
        ? launchPackagedMacProbe
        : process.platform === 'linux'
          ? launchPackagedLinuxProbe
          : process.platform === 'win32'
            ? launchPackagedWindowsProbe
            : null
      if (launchPackagedProbe) {
        const probe = await launchPackagedProbe(paths, executablePath, { timeoutMs: packagedLaunchTimeoutMs })
        assert.deepEqual(probe.surface, {
          sessionCreate: 'function',
          settingsSet: 'function',
          workflowsStartDraft: 'function',
          updatesInstallCapability: 'function',
          onSessionPatch: 'function',
        })
        assert.equal(typeof probe.settings.effectiveProviderId, 'string')
        assert.equal(typeof probe.settings.effectiveModel, 'string')
        assert.equal(typeof probe.installCapability.supported, 'boolean')
        assert.ok(
          probe.installCapability.reason === undefined
            || typeof probe.installCapability.reason === 'string',
        )
        return
      }

      session = await launchSmokeSession(paths, {
        executablePath,
        appShellTimeoutMs: packagedLaunchTimeoutMs,
      })

      const surface = await withTimeout(
        'checking packaged preload surface',
        session.page.evaluate(() => {
          const api = window.coworkApi as unknown as Record<string, Record<string, unknown>>
          return {
            sessionCreate: typeof api.session?.create,
            settingsSet: typeof api.settings?.set,
            workflowsStartDraft: typeof api.workflows?.startDraft,
            updatesInstallCapability: typeof api.updates?.installCapability,
            onSessionPatch: typeof api.on?.sessionPatch,
          }
        }),
        packagedIpcTimeoutMs,
      )
      assert.deepEqual(surface, {
        sessionCreate: 'function',
        settingsSet: 'function',
        workflowsStartDraft: 'function',
        updatesInstallCapability: 'function',
        onSessionPatch: 'function',
      })

      const readOnlyContracts = await withTimeout(
        'reading packaged settings and update capability',
        session.page.evaluate(async () => ({
          settings: await window.coworkApi.settings.get(),
          installCapability: await window.coworkApi.updates.installCapability(),
        })),
        packagedIpcTimeoutMs,
      )
      assert.equal(typeof readOnlyContracts.settings.effectiveProviderId, 'string')
      assert.equal(typeof readOnlyContracts.settings.effectiveModel, 'string')
      assert.equal(typeof readOnlyContracts.installCapability.supported, 'boolean')
      assert.ok(
        readOnlyContracts.installCapability.reason === undefined
          || typeof readOnlyContracts.installCapability.reason === 'string',
      )
    } finally {
      if (session) await session.close()
      cleanupSmokePaths(paths)
    }
  },
)
