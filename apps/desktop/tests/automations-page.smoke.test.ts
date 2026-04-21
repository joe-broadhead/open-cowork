import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

test('automations page shows an overview landing state before any automation exists', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    await page.getByRole('button', { name: 'Automations', exact: true }).click()

    await page.getByRole('heading', { name: 'Turn repeatable work into a standing agent program', exact: true }).waitFor()
    await page.getByText('How it works', { exact: true }).waitFor()
    await page.getByText('Recent automation activity', { exact: true }).waitFor()
  } finally {
    await cleanup()
  }
})

test('automations page creates and renders an automation', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    await page.getByRole('button', { name: 'Automations', exact: true }).click()

    await page.getByPlaceholder('Weekly market report').fill('Weekly market report')
    await page.getByPlaceholder('Build a weekly analysis and market research report and keep it ready for review every Monday morning.').fill(
      'Build a weekly market and performance report for leadership.',
    )
    await page.getByRole('button', { name: 'Create automation', exact: true }).click()

    await page.getByRole('heading', { name: 'Weekly market report', exact: true }).waitFor()
    await page.getByText('Execution brief', { exact: true }).waitFor()
    await page.getByText('Run timeline', { exact: true }).waitFor()
    await page.getByText('Quick edits', { exact: true }).waitFor()
    await page.getByText('Reliability', { exact: true }).waitFor()
    await page.getByText('Run policy', { exact: true }).waitFor()

    const payload = await page.evaluate(async () => {
      return window.coworkApi.automation.list()
    })

    assert.equal(payload.automations.length, 1)
    assert.equal(payload.automations[0]?.title, 'Weekly market report')
    assert.equal(payload.automations[0]?.status, 'draft')
    assert.deepEqual(payload.automations[0]?.runPolicy, {
      dailyRunCap: 6,
      maxRunDurationMinutes: 120,
    })
  } finally {
    await cleanup()
  }
})

test('automation templates prefill the draft and scoped execution requires a project directory', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    await page.getByRole('button', { name: 'Automations', exact: true }).click()

    await page.getByRole('button', { name: 'Managed project', exact: true }).click()

    assert.equal(await page.locator('input').first().inputValue(), 'Managed product roadmap')
    assert.equal(
      await page.locator('textarea').first().inputValue(),
      'Maintain a clear roadmap for this project, enrich the next execution-ready tasks, and keep progress moving forward without guessing when context is missing.',
    )

    await page.locator('select').nth(2).selectOption('scoped_execution')
    await page.getByText('Scoped execution needs a project directory so the agent team has an explicit workspace boundary.').waitFor()

    await page.getByRole('button', { name: 'Create automation', exact: true }).click()
    await page.getByText('Scoped execution automations require a project directory.').waitFor()
  } finally {
    await cleanup()
  }
})

test('automation draft resets to the saved automation defaults after create', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    await page.evaluate(async () => {
      await window.coworkApi.settings.set({
        defaultAutomationAutonomyPolicy: 'mostly-autonomous',
        defaultAutomationExecutionMode: 'scoped_execution',
      })
    })

    await page.getByRole('button', { name: 'Automations', exact: true }).click()

    await page.getByPlaceholder('Weekly market report').fill('Default reset check')
    await page.getByPlaceholder('Build a weekly analysis and market research report and keep it ready for review every Monday morning.').fill(
      'Verify the create form resets using the saved automation defaults.',
    )
    await page.getByPlaceholder('Optional project directory').fill('/tmp/open-cowork-automation')
    await page.getByRole('button', { name: 'Create automation', exact: true }).click()
    await page.getByRole('heading', { name: 'Default reset check', exact: true }).waitFor()

    assert.equal(await page.locator('select').nth(2).inputValue(), 'scoped_execution')
    assert.equal(await page.locator('select').nth(3).inputValue(), 'mostly-autonomous')
  } finally {
    await cleanup()
  }
})

test('automation creation persists preferred specialists', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    await page.getByRole('button', { name: 'Automations', exact: true }).click()

    await page.getByRole('button', { name: /General/i }).click()
    await page.getByRole('button', { name: /Explore/i }).click()
    await page.getByPlaceholder('Weekly market report').fill('Specialist team check')
    await page.getByPlaceholder('Build a weekly analysis and market research report and keep it ready for review every Monday morning.').fill(
      'Verify the selected specialist team persists through automation creation.',
    )
    await page.getByRole('button', { name: 'Create automation', exact: true }).click()
    await page.getByRole('heading', { name: 'Specialist team check', exact: true }).waitFor()

    const payload = await page.evaluate(async () => {
      return window.coworkApi.automation.list()
    })

    assert.deepEqual(payload.automations[0]?.preferredAgentNames, ['general', 'explore'])
  } finally {
    await cleanup()
  }
})
