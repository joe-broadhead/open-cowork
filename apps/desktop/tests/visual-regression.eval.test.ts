import assert from 'node:assert/strict'
import test from 'node:test'
import type { CDPSession, Page } from 'playwright-core'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'
import { compareToBaseline, setColorScheme } from './eval-helpers.ts'

// EVAL FLOW: visual regression for the retained appearance support matrix.
//
// Captures the retained Mercury theme in both color schemes and every retained
// density class, then diffs each Home state against a baseline PNG using an
// in-renderer, dependency-free pixel
// comparison (see compareToBaseline). A large structural change (broken
// layout, blank surface, theme flip) pushes the diff ratio over threshold and
// fails the eval; sub-pixel churn stays under it.
//
// BASELINES: ordinary runs are read-only and fail if a committed PNG is
// missing. A maintainer can enter the explicit review/update mode with
// OPEN_COWORK_EVAL_UPDATE_BASELINES=1, inspect the resulting PNGs, and commit
// only the accepted baselines.

const RESPONSIVE_VIEWPORTS = [
  { width: 800, mode: 'compact' },
  { width: 1024, mode: 'balanced' },
  { width: 1440, mode: 'wide' },
] as const
const VISUAL_CAPTURE_TIME = '2026-08-01T13:00:00.000Z'

type KnowledgeState = 'empty' | 'populated'

async function pinVisualCaptureTime(page: Page) {
  await page.clock.setFixedTime(VISUAL_CAPTURE_TIME)
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  // Home may already have rendered its time-of-day greeting before the clock
  // override was installed. Reload under the fixed clock so the first capture
  // is as deterministic as every later capture that inherits the override.
  await page.reload()
  await waitForAppShell(page, 30_000)
  await waitForStableConnectionStatus(page)
}

async function gotoHome(page: Page) {
  await page.getByRole('button', { name: 'Home', exact: true }).first().click()
  await page.waitForSelector('h1:has-text("Good")', { timeout: 30_000 })
}

async function gotoTeam(page: Page) {
  await page.getByRole('button', { name: 'Team', exact: true }).first().click()
  await page.waitForSelector('h1:has-text("Coworkers")', { timeout: 30_000 })
  await page.getByText('Built-in coworkers', { exact: true }).waitFor({ timeout: 10_000 })
}

async function gotoProjects(page: Page) {
  await page.locator('[data-nav-view="projects"]').click()
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor({ timeout: 30_000 })
  await page.locator('button.studio-kanban-task-button').filter({ hasText: 'Responsive launch task' }).waitFor({ timeout: 10_000 })
}

async function waitForStableConnectionStatus(page: Page) {
  await page.getByRole('button', { name: /\d+\/\d+ MCPs/i }).waitFor({ timeout: 30_000 })
}

async function gotoKnowledge(page: Page) {
  await page.locator('[data-nav-view="knowledge"]').click()
  await page.getByRole('heading', { name: 'Knowledge', exact: true }).waitFor({ timeout: 30_000 })
  await page.getByRole('heading', { name: 'Start your knowledge base', exact: true }).waitFor({ timeout: 10_000 })
}

async function setDensity(page: Page, density: 'compact' | 'regular' | 'comfy') {
  await page.evaluate((nextDensity) => {
    localStorage.setItem('open-cowork-ui-theme', 'mercury')
    localStorage.setItem('open-cowork-ui-accent', 'theme')
    localStorage.setItem('open-cowork-density', nextDensity)
  }, density)
  await page.reload()
  await waitForAppShell(page, 30_000)
  await waitForStableConnectionStatus(page)
}

async function setResponsiveViewport(
  page: Page,
  session: CDPSession,
  viewport: typeof RESPONSIVE_VIEWPORTS[number],
) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await page.waitForFunction((width) => window.innerWidth === width, viewport.width, { timeout: 10_000 })
  // Let the responsive shell and drawer transitions settle before measuring.
  await page.waitForTimeout(250)
}

async function setKnowledgeViewport(
  page: Page,
  session: CDPSession,
  viewport: typeof RESPONSIVE_VIEWPORTS[number],
) {
  await setResponsiveViewport(page, session, viewport)
  await page.locator(`[data-knowledge-viewport="${viewport.mode}"]`).waitFor({ timeout: 10_000 })
}

async function assertNoHorizontalPageOverflow(page: Page, label: string) {
  const measurements = await page.evaluate(() => ({
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    rootClientWidth: document.documentElement.clientWidth,
    rootScrollWidth: document.documentElement.scrollWidth,
  }))
  assert.ok(
    measurements.bodyScrollWidth <= measurements.bodyClientWidth + 1,
    `${label} overflows the body horizontally: ${JSON.stringify(measurements)}`,
  )
  assert.ok(
    measurements.rootScrollWidth <= measurements.rootClientWidth + 1,
    `${label} overflows the document horizontally: ${JSON.stringify(measurements)}`,
  )
}

async function assertKnowledgeViewport(
  page: Page,
  viewport: typeof RESPONSIVE_VIEWPORTS[number],
  state: KnowledgeState,
) {
  const centerWidth = state === 'populated'
    ? await page.locator('.knowledge-workbench__main').evaluate((center) => center.getBoundingClientRect().width)
    : await page
        .getByRole('heading', { name: 'Start your knowledge base', exact: true })
        .evaluate((heading) => heading.closest('.ui-card')?.getBoundingClientRect().width || 0)
  await assertNoHorizontalPageOverflow(page, `Knowledge ${state} at ${viewport.width}px`)
  assert.ok(
    centerWidth >= 320,
    `Knowledge ${state} at ${viewport.width}px leaves only ${centerWidth}px for the center workspace`,
  )
}

async function seedProjectsBoard(page: Page) {
  await page.evaluate(async () => {
    const project = await window.coworkApi.coordination.createProject({
      title: 'Responsive launch plan',
      objective: 'Keep the Projects core journey usable at every retained desktop width.',
      team: ['build'],
    })
    await window.coworkApi.coordination.createTask({
      projectId: project.id,
      title: 'Responsive launch task',
      spec: 'Open this task, review its detail, and advance its stage.',
      status: 'running',
      column: 'doing',
      priority: 'high',
      assigneeAgent: 'build',
      assignedSessionId: null,
    })
  })
}

async function seedKnowledgePage(page: Page) {
  const pageTitle = 'Visual eval workspace guide'
  await page.evaluate(async (title) => {
    const space = await window.coworkApi.knowledge.createSpace({
      workspaceId: 'local',
      name: 'Product handbook',
      visibility: 'team',
    })
    const proposal = await window.coworkApi.knowledge.propose({
      workspaceId: 'local',
      spaceId: space.id,
      pageId: null,
      pageTitle: title,
      by: 'Visual eval',
      summary: 'Seed the populated Knowledge visual-regression state.',
      body: [
        { id: 'heading', type: 'h', text: 'How we work' },
        { id: 'body', type: 'p', text: 'A maintained reference for product decisions, owners, and follow-up work.' },
      ],
      links: [],
    })
    await window.coworkApi.knowledge.acceptProposal(proposal.id, {
      workspaceId: 'local',
      reviewedBy: 'Visual eval',
    })
  }, pageTitle)

  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await page.getByRole('button', { name: pageTitle, exact: true }).click()
  await page.getByRole('heading', { name: pageTitle, exact: true }).waitFor({ timeout: 15_000 })
}

test('eval:visual — retained Mercury theme and density classes match baselines', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    await waitForAppShell(page)

    for (const density of ['compact', 'regular', 'comfy'] as const) {
      await setDensity(page, density)
      for (const scheme of ['light', 'dark'] as const) {
        await setColorScheme(page, scheme)
        await pinVisualCaptureTime(page)
        await gotoHome(page)
        // Let fonts/animation settle before the pixel capture.
        await page.waitForTimeout(450)
        const result = await compareToBaseline(page, `home-mercury-${density}-${scheme}`)
        assert.ok(
          result.passed,
          `visual regression on mercury-${density}-${scheme}: diff ${(result.diffRatio * 100).toFixed(2)}% exceeded ${(result.threshold * 100).toFixed(2)}%`,
        )
      }
    }

    // Keep one denser secondary surface in the representative matrix so the
    // shell is not the only component covered by retained-theme snapshots.
    await setDensity(page, 'regular')
    await setColorScheme(page, 'dark')
    await gotoTeam(page)
    const team = await compareToBaseline(page, 'team-mercury-regular-dark')
    assert.ok(team.passed, `visual regression on team-mercury-regular-dark: diff ${(team.diffRatio * 100).toFixed(2)}%`)
  } finally {
    await cleanup()
  }
})

test('eval:visual — Home and Projects remain usable at retained desktop widths', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    await waitForAppShell(page)
    await setDensity(page, 'regular')
    await setColorScheme(page, 'dark')
    await pinVisualCaptureTime(page)
    await gotoHome(page)
    const cdp = await page.context().newCDPSession(page)

    for (const viewport of RESPONSIVE_VIEWPORTS) {
      await setResponsiveViewport(page, cdp, viewport)
      await page.locator('[data-testid="home-view"] .home-density-composer textarea').waitFor({ timeout: 10_000 })
      const composerWidth = await page.locator('.home-density-composer').evaluate((node) => node.getBoundingClientRect().width)
      assert.ok(composerWidth >= 320, `Home at ${viewport.width}px leaves only ${composerWidth}px for the composer`)
      await assertNoHorizontalPageOverflow(page, `Home at ${viewport.width}px`)
      const result = await compareToBaseline(page, `home-responsive-mercury-regular-dark-${viewport.width}`)
      assert.ok(result.passed, `visual regression on Home at ${viewport.width}px: diff ${(result.diffRatio * 100).toFixed(2)}%`)
    }

    await seedProjectsBoard(page)
    await gotoProjects(page)
    for (const viewport of RESPONSIVE_VIEWPORTS) {
      await setResponsiveViewport(page, cdp, viewport)
      await page.locator('button.studio-kanban-task-button').filter({ hasText: 'Responsive launch task' }).waitFor({ timeout: 10_000 })
      await assertNoHorizontalPageOverflow(page, `Projects at ${viewport.width}px`)
      const result = await compareToBaseline(page, `projects-mercury-regular-dark-${viewport.width}`)
      assert.ok(result.passed, `visual regression on Projects at ${viewport.width}px: diff ${(result.diffRatio * 100).toFixed(2)}%`)
    }
  } finally {
    await cleanup()
  }
})

test('eval:visual — Knowledge empty and populated layouts remain usable across retained widths', async () => {
  const { page, cleanup } = await launchSmokeApp({ enableKnowledge: true })
  try {
    await waitForAppShell(page)
    await setDensity(page, 'regular')
    await setColorScheme(page, 'dark')
    await gotoKnowledge(page)
    const cdp = await page.context().newCDPSession(page)

    for (const viewport of RESPONSIVE_VIEWPORTS) {
      await setKnowledgeViewport(page, cdp, viewport)
      await assertKnowledgeViewport(page, viewport, 'empty')
      const result = await compareToBaseline(
        page,
        `knowledge-empty-mercury-regular-dark-${viewport.width}`,
      )
      assert.ok(
        result.passed,
        `visual regression on Knowledge empty at ${viewport.width}px: diff ${(result.diffRatio * 100).toFixed(2)}%`,
      )
    }

    await seedKnowledgePage(page)

    for (const viewport of RESPONSIVE_VIEWPORTS) {
      await setKnowledgeViewport(page, cdp, viewport)
      await page.locator(`.knowledge-workbench--${viewport.mode}`).waitFor({ timeout: 10_000 })
      await assertKnowledgeViewport(page, viewport, 'populated')
      const result = await compareToBaseline(
        page,
        `knowledge-populated-mercury-regular-dark-${viewport.width}`,
      )
      assert.ok(
        result.passed,
        `visual regression on Knowledge populated at ${viewport.width}px: diff ${(result.diffRatio * 100).toFixed(2)}%`,
      )
    }
  } finally {
    await cleanup()
  }
})
