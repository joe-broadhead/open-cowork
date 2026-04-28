import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanupSmokePaths,
  createSmokePaths,
  launchSmokeSession,
  waitForAppShell,
  type SmokeSession,
} from './smoke-helpers.ts'

const packagedExecutablePath = process.env.OPEN_COWORK_PACKAGED_EXECUTABLE?.trim()

test(
  'packaged app launches cleanly and preserves sessions across relaunch',
  {
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
      firstLaunch = await launchSmokeSession(paths, { executablePath, appShellTimeoutMs: 90_000 })
      await waitForAppShell(firstLaunch.page, 90_000)

      const initialSessions = await firstLaunch.page.evaluate(async () => window.coworkApi.session.list())
      const initialIds = initialSessions.map((session) => session.id)

      await firstLaunch.page.evaluate(async () => {
        await window.coworkApi.session.create(null)
      })

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

      secondLaunch = await launchSmokeSession(paths, { executablePath, appShellTimeoutMs: 90_000 })
      await waitForAppShell(secondLaunch.page, 90_000)

      const afterRelaunch = await secondLaunch.page.evaluate(async () => window.coworkApi.session.list())
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
