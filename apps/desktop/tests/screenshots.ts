import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CDPSession, Page } from 'playwright-core'
import {
  cleanupSmokePaths,
  createSmokePaths,
  launchSmokeSession,
  repoRoot,
  type SmokeSession,
  waitForAppShell,
} from './smoke-helpers.ts'

// Drives the same Electron harness the smoke tests use, but instead of
// asserting layout it walks the entire app surface and writes PNGs into
// docs/assets/auto/. Every shot is dark-mode at 1600x1000 (DSF=1) to
// match the manual-capture guidelines in docs/assets/README.md and to
// stay deterministic across machines.

const VIEWPORT = { width: 1600, height: 1000 }
const SETTLE_MS = 450

let cdp: CDPSession | null = null

async function ensureCdp(page: Page) {
  if (!cdp) {
    cdp = await page.context().newCDPSession(page)
  }
  return cdp
}

async function pinViewport(page: Page) {
  const session = await ensureCdp(page)
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  })
}

async function applyDarkMode(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem('open-cowork-color-scheme', 'dark')
  })
  await page.reload()
  await waitForAppShell(page, 30_000)
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-color-scheme') === 'dark',
    null,
    { timeout: 5_000 },
  )
  cdp = null // CDP session is invalidated on reload
  await pinViewport(page)
}

function resolveScreenshotExecutable() {
  const executable = process.env.OPEN_COWORK_SCREENSHOT_EXECUTABLE?.trim()
  if (!executable) return undefined
  const resolved = resolve(repoRoot, executable)
  if (resolved.endsWith('.app')) {
    return join(resolved, 'Contents/MacOS/Open Cowork')
  }
  return resolved
}

async function shoot(page: Page, outputDir: string, name: string) {
  await page.waitForTimeout(SETTLE_MS)
  const path = join(outputDir, `${name}.png`)
  await page.screenshot({ path, fullPage: false })
  process.stdout.write(`[screenshots]   ${name}\n`)
}

async function gotoHome(page: Page) {
  await page.getByRole('button', { name: 'Home', exact: true }).first().click()
  // Home greeting is "Good {morning|afternoon|evening}." — match the stable lead word.
  await page.waitForSelector('h1:has-text("Good")', { timeout: 30_000 })
}

async function gotoAgents(page: Page) {
  await page.getByRole('button', { name: 'Team', exact: true }).first().click()
  // Studio copy: the Team page header is "Coworkers" and built-ins render
  // under the "Built-in coworkers" section label.
  await page.waitForSelector('h1:has-text("Coworkers")', { timeout: 30_000 })
  await page.getByText('Built-in coworkers', { exact: true }).waitFor({ timeout: 10_000 })
}

async function gotoCapabilities(page: Page) {
  await page.getByRole('button', { name: 'Tools & Skills', exact: true }).first().click()
  await page.waitForSelector('h1:has-text("Tools & Skills")', { timeout: 30_000 })
}

async function gotoWorkflows(page: Page) {
  await page.getByRole('button', { name: 'Playbooks', exact: true }).first().click()
  await page.getByRole('heading', { name: 'Playbooks', exact: true }).waitFor({ timeout: 30_000 })
}

async function captureSettingsTabs(page: Page, outputDir: string) {
  // Open the Settings panel from the sidebar — this expands the sidebar
  // to ~640px and replaces ThreadList with the SettingsPanel component.
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
  await page.waitForSelector('text=Appearance', { timeout: 10_000 })

  // Each settings tab button renders the label + a description on the
  // next line, so the accessible name is "Appearance Theme, color
  // scheme, and fonts". Match the leading label rather than exact-name.
  // Studio copy renamed "Models" → "Model" and "Workflows" → "Playbooks";
  // the historical asset IDs stay stable so docs references don't break.
  const tabs: Array<{ pattern: RegExp; id: string }> = [
    { pattern: /^Appearance\b/, id: 'settings-appearance' },
    { pattern: /^Model\b/, id: 'settings-models' },
    { pattern: /^Permissions\b/, id: 'settings-permissions' },
    { pattern: /^Playbooks\b/, id: 'settings-workflows' },
    { pattern: /^Storage\b/, id: 'settings-storage' },
  ]

  for (const tab of tabs) {
    await page.getByRole('button', { name: tab.pattern }).first().click()
    await page.waitForTimeout(200)
    await shoot(page, outputDir, tab.id)
  }

  // Settings now renders as a modal Dialog; close it via the Dialog's
  // "Close dialog" icon button (Escape as a fallback) so the modal does
  // not intercept pointer events for every capture that follows.
  await page.getByRole('button', { name: 'Close dialog', exact: true }).first().click().catch(() => undefined)
  await page.keyboard.press('Escape').catch(() => undefined)
  await page.locator('[role="dialog"]').first().waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined)
  await page.waitForTimeout(200)
}

async function captureCapabilitiesViews(page: Page, outputDir: string) {
  await gotoCapabilities(page)
  await shoot(page, outputDir, 'capabilities-tools')

  // Switch to the Abilities (skills) view. The tab strip is a SegmentedControl
  // (role=radiogroup with role=radio options) in the page header; Studio copy
  // renamed the tabs to "Tools & Skills" / "Connections" / "Abilities".
  const mainArea = page.locator('main')
  await mainArea.getByRole('radio', { name: 'Abilities', exact: true }).first().click()
  await page.waitForTimeout(200)
  await shoot(page, outputDir, 'capabilities-skills')

  // Open the Add ability form
  await mainArea.getByRole('button', { name: 'Add ability', exact: true }).click()
  await page.waitForTimeout(400)
  await shoot(page, outputDir, 'capabilities-add-skill')

  // Cancel back to the Abilities view
  await mainArea.getByRole('button', { name: /Cancel/i }).first().click()
  await page.waitForTimeout(200)

  // Switch to Connections (tools) and open Add connection
  await mainArea.getByRole('radio', { name: 'Connections', exact: true }).first().click()
  await page.waitForTimeout(150)
  await mainArea.getByRole('button', { name: 'Add connection', exact: true }).click()
  await page.waitForTimeout(400)
  await shoot(page, outputDir, 'capabilities-add-tool')

  await mainArea.getByRole('button', { name: /Cancel/i }).first().click()
  await page.waitForTimeout(200)

  // Open the first tool detail card. CapabilitySelectionCard renders
  // each card as `<button class="w-full text-start p-4 ...">`, so the
  // class combo is a stable selector that won't match the action row.
  const cards = await mainArea.locator('button.text-start.p-4').all()
  if (cards.length > 0) {
    await cards[0]!.click()
    await page.waitForTimeout(400)
    await shoot(page, outputDir, 'capabilities-tool-detail')
    // The detail page has a back button labeled "Tools & Skills" with a
    // chevron icon — clicking it returns to the grid.
    await mainArea.getByRole('button', { name: /^Tools & Skills$/ }).first().click().catch(() => undefined)
    await page.waitForTimeout(200)
  } else {
    console.warn('[screenshots]   (no capability cards found, skipping detail view)')
  }
}

async function captureAgentsViews(page: Page, outputDir: string) {
  await gotoAgents(page)
  await shoot(page, outputDir, 'agents')

  // Open the template picker via "New coworker"
  await page.getByRole('button', { name: /New coworker/ }).click()
  // The picker header is unique copy that won't appear elsewhere on the page.
  await page.getByRole('heading', { name: 'Start a new coworker', exact: true }).waitFor({ timeout: 10_000 })
  await shoot(page, outputDir, 'agents-template-picker')

  // Pick "Start from blank" — that's the last template in the picker
  // and unconditionally routes into the AgentBuilderPage with a blank
  // seed. No heuristics, no card-text matching.
  await page.getByRole('button', { name: /Start from blank/i }).click()
  // The builder's save affordance for a not-yet-created coworker is the
  // unique "Hire coworker" button that doesn't appear on the grid.
  await page.getByRole('button', { name: 'Hire coworker', exact: true }).waitFor({ timeout: 10_000 })
  await shoot(page, outputDir, 'agents-builder')

  // Exit the builder via the chevron-left "Team" back button (scoped to
  // main so it can't hit the sidebar's Team nav item). A blank draft counts
  // as dirty (template seeding replaces the draft reference), so confirm
  // the "Discard unsaved changes?" dialog when it appears.
  await page.locator('main').getByRole('button', { name: 'Team', exact: true }).first().click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click({ timeout: 3_000 }).catch(() => undefined)
  await page.waitForSelector('h1:has-text("Coworkers")', { timeout: 10_000 })

  // Click a real built-in agent card to capture the workbench in
  // read-only mode (with capabilities and instructions populated).
  // Card click target = `<button class="w-full text-start p-4 ...">`.
  const cards = page.locator('main button.text-start.p-4')
  if (await cards.count()) {
    await cards.first().click()
    // Built-in coworkers render the workbench read-only; wait on the
    // "Model & behavior" tab, which never appears on the Coworkers grid.
    await page.locator('main').getByRole('button', { name: 'Model & behavior', exact: true }).waitFor({ timeout: 10_000 })
    await shoot(page, outputDir, 'agents-builder-detail')
    // Exit via the chevron-left "Team" back link
    await page.locator('main').getByRole('button', { name: 'Team', exact: true }).first().click().catch(() => undefined)
    await page.waitForSelector('h1:has-text("Coworkers")', { timeout: 10_000 })
  }
}

async function captureWorkflowsViews(page: Page, outputDir: string) {
  await gotoWorkflows(page)
  await shoot(page, outputDir, 'workflows-overview')
  // Workflows are now created through a setup thread instead of a
  // separate template/detail modal. Keep the historical screenshot IDs
  // as current Workflows surface captures so downstream docs that
  // reference the full generated asset set do not lose files.
  await shoot(page, outputDir, 'workflows-template')
  await shoot(page, outputDir, 'workflows-detail')
}

async function captureChatViews(page: Page, outputDir: string) {
  await gotoHome(page)
  // Use the sidebar new-thread path so the Chat surface is real, but
  // avoid firing a provider request. Screenshot runs should not depend
  // on API keys or capture a missing-credential error banner.
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.getByRole('button', { name: /^Blank chat\b/ }).click()
  await page.waitForSelector('h1:has-text("Good")', {
    state: 'detached',
    timeout: 15_000,
  })
  // Wait for the chat composer to mount — that's our signal the chat
  // view has fully painted.
  const chatComposer = page.locator('textarea').first()
  await chatComposer.waitFor({ timeout: 15_000 })
  await page.waitForTimeout(500)
  await shoot(page, outputDir, 'chat-thread')

  // Mention picker
  await chatComposer.fill('')
  await chatComposer.type('@')
  await page.waitForSelector('text=/research|explore|build|plan|charts/i', { timeout: 5_000 })
  await page.waitForTimeout(200)
  await shoot(page, outputDir, 'chat-mention-picker')

  // Clear so future captures don't carry residue
  await chatComposer.fill('')
}

async function captureSidebarSearch(page: Page, outputDir: string) {
  await gotoHome(page)
  // The sidebar search toggle lives next to the New thread button —
  // it's the second button in the top sidebar row.
  const searchToggle = page.locator('aside button[title*="Search"]').first()
  if (await searchToggle.count()) {
    await searchToggle.click()
    await page.waitForTimeout(250)
    await shoot(page, outputDir, 'sidebar-search')
    // Close it back
    await page.keyboard.press('Escape').catch(() => undefined)
    await page.waitForTimeout(150)
  } else {
    console.warn('[screenshots]   (sidebar search toggle not found)')
  }
}

async function main() {
  const outputDir = resolve(repoRoot, 'docs/assets/auto')
  const captureDir = mkdtempSync(join(tmpdir(), 'open-cowork-screenshots-'))
  process.stdout.write(`[screenshots] output dir: ${outputDir}\n`)

  const paths = createSmokePaths()
  let session: SmokeSession | null = null
  try {
    session = await launchSmokeSession(paths, { executablePath: resolveScreenshotExecutable() })
    const page = session.page

    await pinViewport(page)
    await applyDarkMode(page)

    // Section: top-level pages (clean state)
    await gotoHome(page); await shoot(page, captureDir, 'home')

    // Section: capabilities (multi-view)
    await captureCapabilitiesViews(page, captureDir)

    // Section: agents (list + template picker + builder)
    await captureAgentsViews(page, captureDir)

    // Section: workflows
    await captureWorkflowsViews(page, captureDir)

    // Section: settings panel tabs
    await gotoHome(page)
    await captureSettingsTabs(page, captureDir)

    // Section: sidebar search
    await captureSidebarSearch(page, captureDir)

    // Section: chat thread + mention picker (mutates state, run last)
    await captureChatViews(page, captureDir)

    rmSync(outputDir, { recursive: true, force: true })
    mkdirSync(resolve(outputDir, '..'), { recursive: true })
    renameSync(captureDir, outputDir)
  } finally {
    await session?.close()
    cleanupSmokePaths(paths)
    rmSync(captureDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('[screenshots] failed:', error)
  process.exit(1)
})
