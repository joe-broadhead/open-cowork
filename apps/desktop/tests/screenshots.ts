import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CDPSession, Page } from 'playwright-core'
import { DOCUMENTATION_SCREENSHOT_JOURNEYS } from './documentation-screenshot-journeys.mjs'
import {
  cleanupSmokePaths,
  createSmokePaths,
  launchSmokeSession,
  repoRoot,
  type SmokeSession,
  waitForAppShell,
} from './smoke-helpers.ts'

// Minimal public documentation set: one distinct state for every core journey.
// The isolated profile retains real Open Cowork branding, public feature
// defaults, and no customer credentials or project data.

const VIEWPORT = { width: 1600, height: 1000 }
const DOCUMENTATION_CAPTURE_TIME = '2026-08-01T13:00:00.000Z'
const DOCUMENTATION_CHAT_TITLE = 'Launch brief planning'
const JOURNEYS_BY_ID = new Map(DOCUMENTATION_SCREENSHOT_JOURNEYS.map((journey) => [journey.id, journey]))
const SETTLED_SURFACE_BY_JOURNEY = new Map([
  ['team', 'team-surface'],
  ['playbooks', 'playbooks-surface'],
  ['tools-skills', 'tools-skills-surface'],
])

let cdp: CDPSession | null = null

async function ensureCdp(page: Page) {
  if (!cdp) cdp = await page.context().newCDPSession(page)
  return cdp
}

async function pinViewport(page: Page) {
  const session = await ensureCdp(page)
  await session.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await session.send('Emulation.setDeviceMetricsOverride', {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  })
}

async function applyDarkMode(page: Page) {
  await page.evaluate(() => localStorage.setItem('open-cowork-color-scheme', 'dark'))
  await page.reload()
  await waitForAppShell(page, 30_000)
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-color-scheme') === 'dark',
    null,
    { timeout: 5_000 },
  )
  cdp = null
  await pinViewport(page)
}

function resolveScreenshotExecutable() {
  const executable = process.env.OPEN_COWORK_SCREENSHOT_EXECUTABLE?.trim()
  if (!executable) return undefined
  const resolved = resolve(repoRoot, executable)
  return resolved.endsWith('.app') ? join(resolved, 'Contents/MacOS/Open Cowork') : resolved
}

async function waitForSettledJourney(page: Page, id: string) {
  const surfaceTestId = SETTLED_SURFACE_BY_JOURNEY.get(id)
  if (surfaceTestId) {
    await page.waitForFunction(
      (testId) => {
        const surface = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
        return Boolean(surface && surface.dataset.loadState !== 'loading')
      },
      surfaceTestId,
      { timeout: 30_000 },
    )
    await page.locator('.ui-skeleton').waitFor({ state: 'detached', timeout: 30_000 })
  }
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())))
  })
}

async function shoot(page: Page, outputDir: string, id: string) {
  const journey = JOURNEYS_BY_ID.get(id)
  if (!journey) throw new Error(`Undeclared documentation screenshot: ${id}`)
  await waitForSettledJourney(page, id)
  await page.screenshot({ path: join(outputDir, `${id}.png`), fullPage: false })
  process.stdout.write(`[screenshots] ${id} (${journey.owner})\n`)
}

async function navigate(page: Page, view: string, heading: string | RegExp) {
  await page.locator(`[data-nav-view="${view}"]`).first().click()
  await page.getByRole('heading', { name: heading, exact: typeof heading === 'string' }).first().waitFor({ timeout: 30_000 })
}

async function captureChat(page: Page, outputDir: string) {
  await navigate(page, 'home', /^Good\b/)
  const homeView = page.locator('[data-testid="home-view"]')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.getByRole('button', { name: /^Blank chat\b/ }).click()
  await homeView.waitFor({ state: 'detached', timeout: 15_000 })
  await page.locator('[data-testid="chat-transcript-announcer"]').waitFor({ state: 'attached', timeout: 15_000 })
  const sessionId = await page.evaluate(async (title) => {
    const sessions = await window.coworkApi.session.list()
    if (sessions.length !== 1) throw new Error(`Documentation chat fixture expected one session, found ${sessions.length}.`)
    const renamed = await window.coworkApi.session.rename(sessions[0]!.id, title)
    if (!renamed) throw new Error('Documentation chat fixture could not set its stable title.')
    return sessions[0]!.id
  }, DOCUMENTATION_CHAT_TITLE)
  if (!sessionId) throw new Error('Documentation chat fixture did not create a session.')
  await page.locator('[data-testid="chat-thread-title"]', { hasText: DOCUMENTATION_CHAT_TITLE }).waitFor({ state: 'visible', timeout: 15_000 })
  const composer = page.getByRole('group', { name: /Message composer/ }).locator('textarea')
  await composer.waitFor({ timeout: 15_000 })
  await composer.fill('Turn the launch brief into a concise owner-by-owner action plan.')
  await shoot(page, outputDir, 'chat')
}

async function seedProjects(page: Page) {
  await page.evaluate(async () => {
    const project = await window.coworkApi.coordination.createProject({
      title: 'Private beta readiness',
      objective: 'Close the final product, security, and onboarding evidence for launch.',
      description: 'A deterministic documentation fixture in an isolated test profile.',
      status: 'active',
      team: ['chief-of-staff', 'build', 'research'],
    })
    await Promise.all([
      window.coworkApi.coordination.createTask({
        projectId: project.id,
        title: 'Verify release evidence',
        spec: 'Review the release gates and record any remaining owner actions.',
        column: 'doing',
        status: 'running',
        priority: 'high',
        assigneeAgent: 'chief-of-staff',
      }),
      window.coworkApi.coordination.createTask({
        projectId: project.id,
        title: 'Publish onboarding guide',
        spec: 'Confirm the setup journey and publish the reviewed guide.',
        column: 'review',
        status: 'open',
        priority: 'med',
        assigneeAgent: 'build',
      }),
    ])
  })
}

async function captureSetup(page: Page, outputDir: string) {
  const requiredCredentialCount = await page.evaluate(async () => {
    const [config, settings] = await Promise.all([
      window.coworkApi.app.config(),
      window.coworkApi.settings.get(),
    ])
    const providerId = settings.effectiveProviderId || config.providers.defaultProvider
    const provider = config.providers.available.find((entry) => entry.id === providerId)
    const requiredCredentials = provider?.credentials.filter((credential) => credential.required !== false) || []
    if (!provider || requiredCredentials.length === 0) return 0

    await window.coworkApi.settings.set({
      selectedProviderId: null,
      selectedModelId: null,
      providerCredentials: {
        [provider.id]: Object.fromEntries(requiredCredentials.map((credential) => [credential.key, ''])),
      },
    })
    localStorage.setItem('open-cowork-color-scheme', 'dark')
    return requiredCredentials.length
  })
  if (requiredCredentialCount === 0) {
    throw new Error('Setup screenshot profile must retain at least one required provider credential')
  }

  await page.reload()
  cdp = null
  await page.getByRole('heading', { name: /Welcome/, exact: false }).first().waitFor({ timeout: 30_000 })
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-color-scheme') === 'dark',
    null,
    { timeout: 5_000 },
  )
  await pinViewport(page)
  await shoot(page, outputDir, 'setup')
}

async function main() {
  const outputDir = resolve(repoRoot, 'docs/assets/auto')
  const captureDir = mkdtempSync(join(tmpdir(), 'open-cowork-screenshots-'))
  const shellPaths = createSmokePaths({ productBranding: true, enableApprovals: false })
  const setupPaths = createSmokePaths({
    productBranding: true,
    enableApprovals: false,
    preserveProviderCredentialRequirements: true,
  })
  let session: SmokeSession | null = null

  process.stdout.write(`[screenshots] output: ${outputDir}\n`)
  try {
    const executablePath = resolveScreenshotExecutable()
    session = await launchSmokeSession(shellPaths, { executablePath })
    const page = session.page
    // Keep time-of-day greetings and any renderer-formatted dates stable across
    // developer machines. Timers still advance normally with setFixedTime().
    await page.clock.setFixedTime(DOCUMENTATION_CAPTURE_TIME)
    await pinViewport(page)
    await applyDarkMode(page)

    await navigate(page, 'home', /^Good\b/)
    await shoot(page, captureDir, 'home')

    await seedProjects(page)
    await navigate(page, 'projects', 'Projects')
    await page.getByText('Private beta readiness', { exact: true }).first().waitFor({ timeout: 15_000 })
    await shoot(page, captureDir, 'projects')

    await navigate(page, 'team', 'Coworkers')
    await shoot(page, captureDir, 'team')

    await navigate(page, 'playbooks', 'Playbooks')
    await shoot(page, captureDir, 'playbooks')

    await navigate(page, 'tools', 'Tools & Skills')
    await shoot(page, captureDir, 'tools-skills')

    await captureChat(page, captureDir)

    await session.close()
    session = null
    cdp = null
    session = await launchSmokeSession(setupPaths, { executablePath })
    await captureSetup(session.page, captureDir)

    rmSync(outputDir, { recursive: true, force: true })
    mkdirSync(resolve(outputDir, '..'), { recursive: true })
    renameSync(captureDir, outputDir)
  } finally {
    await session?.close()
    cleanupSmokePaths(shellPaths)
    cleanupSmokePaths(setupPaths)
    rmSync(captureDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('[screenshots] failed:', error)
  process.exitCode = 1
})
