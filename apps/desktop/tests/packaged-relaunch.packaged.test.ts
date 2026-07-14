import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
const expectSignedUpdateInstall = process.env.OPEN_COWORK_EXPECT_SIGNED_UPDATE_INSTALL?.toLowerCase() === 'true'
const packagedRelaunchTimeoutMs = 240_000
const packagedLaunchTimeoutMs = 90_000
const packagedIpcTimeoutMs = 60_000
const packagedSeedSessionId = 'packaged_seed_session'
const updateInstallUnsupportedReasons = new Set([
  'dev',
  'unsigned',
  'platform',
  'missing-feed',
  'source-disabled',
  'source-misconfigured',
  'auth-required',
  'auth-expired',
  'auth-forbidden',
  'source-unreachable',
  'unavailable',
])

function makePackagedSeedSession() {
  const now = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString()
  return {
    id: packagedSeedSessionId,
    title: 'Packaged seed thread',
    directory: null,
    opencodeDirectory: '/tmp/open-cowork-packaged-seed',
    createdAt: now,
    updatedAt: now,
    kind: 'interactive',
    workflowId: null,
    runId: null,
    providerId: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4',
    composerAgentName: null,
    composerModelId: null,
    composerReasoningVariant: null,
    summary: null,
    parentSessionId: null,
    changeSummary: null,
    revertedMessageId: null,
    managedByCowork: true as const,
  }
}

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

    const paths = createSmokePaths({
      seedBeforeLaunch: ({ dataRoot }) => {
        writeFileSync(join(dataRoot, 'sessions.json'), JSON.stringify({
          schemaVersion: 1,
          sessions: [makePackagedSeedSession()],
        }, null, 2))
      },
    })
    let firstLaunch: SmokeSession | null = null
    let secondLaunch: SmokeSession | null = null

    try {
      const launchPackagedProbe = process.platform === 'darwin'
        ? launchPackagedMacProbe
        : process.platform === 'linux'
          ? launchPackagedLinuxProbe
          : process.platform === 'win32'
            ? launchPackagedWindowsProbe
            : null
      if (launchPackagedProbe) {
        const firstProbe = await launchPackagedProbe(paths, executablePath, {
          action: 'list-sessions',
          timeoutMs: packagedLaunchTimeoutMs,
        })
        assert.equal(
          typeof firstProbe.installCapability.currentVersion,
          'string',
          'expected packaged update capability to include the running app version',
        )
        assert.equal(
          String(firstProbe.installCapability.currentVersion).length > 0,
          true,
          'expected packaged update capability version to be non-empty',
        )
        if (expectSignedUpdateInstall) {
          assert.equal(firstProbe.installCapability.supported, true, 'expected signed packaged macOS build to advertise in-app update install support')
          assert.equal(firstProbe.installCapability.reason, undefined)
        } else {
          assert.equal(firstProbe.installCapability.supported, false, 'expected unsigned or unsupported packaged build to keep in-app update install disabled')
          assert.equal(
            updateInstallUnsupportedReasons.has(String(firstProbe.installCapability.reason)),
            true,
            `expected a known update install unsupported reason, got ${String(firstProbe.installCapability.reason)}`,
          )
        }

        assert.ok(
          firstProbe.sessions.some((session) => session.id === packagedSeedSessionId),
          'expected packaged app to load the seeded session before relaunch',
        )

        const secondProbe = await launchPackagedProbe(paths, executablePath, {
          action: 'list-sessions',
          timeoutMs: packagedLaunchTimeoutMs,
        })
        assert.ok(
          secondProbe.sessions.some((session) => session.id === packagedSeedSessionId),
          'expected seeded session to survive a packaged-app relaunch',
        )
        return
      }

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
