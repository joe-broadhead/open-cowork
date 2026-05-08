import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanupSmokePaths,
  createSmokePaths,
  launchSmokeSession,
  type SmokeSession,
} from './smoke-helpers.ts'

const packagedExecutablePath = process.env.OPEN_COWORK_PACKAGED_EXECUTABLE?.trim()
const expectSignedUpdateInstall = process.env.OPEN_COWORK_EXPECT_SIGNED_UPDATE_INSTALL?.toLowerCase() === 'true'
const packagedRelaunchTimeoutMs = 240_000
const packagedLaunchTimeoutMs = 90_000
const packagedIpcTimeoutMs = 60_000
const updateInstallUnsupportedReasons = new Set([
  'dev',
  'unsigned',
  'platform',
  'missing-feed',
  'unavailable',
])

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
  'packaged app launches cleanly and preserves sessions across relaunch',
  {
    timeout: packagedRelaunchTimeoutMs,
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
    let firstLaunch: SmokeSession | null = null
    let secondLaunch: SmokeSession | null = null

    try {
      firstLaunch = await launchSmokeSession(paths, {
        executablePath,
        appShellTimeoutMs: packagedLaunchTimeoutMs,
      })

      const updateInstallCapability = await withTimeout(
        'checking packaged update install capability',
        firstLaunch.page.evaluate(async () => window.coworkApi.updates.installCapability()),
        packagedIpcTimeoutMs,
      )
      assert.equal(
        typeof updateInstallCapability.currentVersion,
        'string',
        'expected packaged update capability to include the running app version',
      )
      assert.equal(
        updateInstallCapability.currentVersion.length > 0,
        true,
        'expected packaged update capability version to be non-empty',
      )
      if (expectSignedUpdateInstall) {
        assert.equal(updateInstallCapability.supported, true, 'expected signed packaged macOS build to advertise in-app update install support')
        assert.equal(updateInstallCapability.reason, undefined)
      } else {
        assert.equal(updateInstallCapability.supported, false, 'expected unsigned or unsupported packaged build to keep in-app update install disabled')
        assert.equal(
          updateInstallUnsupportedReasons.has(String(updateInstallCapability.reason)),
          true,
          `expected a known update install unsupported reason, got ${String(updateInstallCapability.reason)}`,
        )
      }

      const initialSessions = await withTimeout(
        'listing packaged sessions before relaunch',
        firstLaunch.page.evaluate(async () => window.coworkApi.session.list()),
        packagedIpcTimeoutMs,
      )
      const initialIds = initialSessions.map((session) => session.id)

      await withTimeout(
        'creating packaged smoke session',
        firstLaunch.page.evaluate(async () => {
          await window.coworkApi.session.create(null)
        }),
        packagedIpcTimeoutMs,
      )

      await firstLaunch.page.waitForFunction(
        async (beforeIds) => {
          const sessions = await window.coworkApi.session.list()
          return sessions.some((session) => !beforeIds.includes(session.id))
        },
        initialIds,
        { timeout: 15_000 },
      )

      const createdSessionId = await firstLaunch.page.evaluate(async (beforeIds) => {
        const sessions = await window.coworkApi.session.list()
        return sessions.find((session) => !beforeIds.includes(session.id))?.id ?? null
      }, initialIds)

      assert.ok(createdSessionId, 'expected packaged app to persist a newly created session before relaunch')

      await firstLaunch.close()
      firstLaunch = null

      secondLaunch = await launchSmokeSession(paths, {
        executablePath,
        appShellTimeoutMs: packagedLaunchTimeoutMs,
      })

      const afterRelaunch = await withTimeout(
        'listing packaged sessions after relaunch',
        secondLaunch.page.evaluate(async () => window.coworkApi.session.list()),
        packagedIpcTimeoutMs,
      )
      assert.ok(
        afterRelaunch.some((session) => session.id === createdSessionId),
        'expected created session to survive a packaged-app relaunch',
      )
    } finally {
      if (firstLaunch) await firstLaunch.close()
      if (secondLaunch) await secondLaunch.close()
      cleanupSmokePaths(paths)
    }
  },
)
