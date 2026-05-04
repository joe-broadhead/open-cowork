import assert from 'node:assert/strict'
import test from 'node:test'
import type { Page } from 'playwright-core'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

test('automations page shows an overview landing state before any automation exists', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    await page.getByRole('button', { name: 'Automations', exact: true }).click()

    await page.getByRole('heading', { name: 'Turn repeatable work into a standing agent program', exact: true }).waitFor()
    await page.getByRole('button', { name: /New automation/i }).waitFor()
    await page.getByRole('button', { name: /Weekly report/ }).first().waitFor()
  } finally {
    await cleanup()
  }
})

async function createWeeklyAutomation(page: Page, title: string, goal: string) {
  await page.getByRole('button', { name: /New automation/i }).first().click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Goal').fill(goal)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Create automation', exact: true }).click()
}

test('automations page creates and renders an automation', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    await page.getByRole('button', { name: 'Automations', exact: true }).click()

    await createWeeklyAutomation(
      page,
      'Weekly market report',
      'Build a weekly market and performance report for leadership.',
    )

    await page.getByRole('heading', { name: 'Setup', exact: true }).waitFor()
    await page.getByRole('button', { name: /Weekly market report/ }).waitFor()
    await page.getByRole('dialog', { name: /Weekly market report/ }).waitFor()
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

    await page.getByRole('button', { name: /New automation/i }).first().click()
    await page.getByRole('dialog', { name: /What & Why/i }).getByRole('button', { name: /Managed project/ }).first().click()

    assert.equal(await page.getByLabel('Title').inputValue(), 'Managed product roadmap')
    assert.equal(
      await page.getByLabel('Goal').inputValue(),
      'Maintain a clear roadmap for this project, enrich the next execution-ready tasks, and keep progress moving forward without guessing when context is missing.',
    )

    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: /Scoped execution/ }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()

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
        defaultAutomationExecutionMode: 'planning_only',
      })
    })

    await page.getByRole('button', { name: 'Automations', exact: true }).click()

    await createWeeklyAutomation(
      page,
      'Default reset check',
      'Verify the create form resets using the saved automation defaults.',
    )
    await page.getByRole('dialog', { name: /Default reset check/ }).waitFor()
    await page.getByRole('button', { name: 'Close automation details' }).click()

    await page.getByRole('button', { name: /New automation/i }).first().click()
    await page.getByLabel('Title').fill('Defaults snapshot')
    await page.getByLabel('Goal').fill('Check defaults after create.')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: /Mostly autonomous/ }).waitFor()
    await page.getByRole('button', { name: /Planning only/ }).waitFor()
  } finally {
    await cleanup()
  }
})

test('automation creation persists preferred specialists', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    await page.getByRole('button', { name: 'Automations', exact: true }).click()

    await page.getByRole('button', { name: /New automation/i }).first().click()
    await page.getByLabel('Title').fill('Specialist team check')
    await page.getByLabel('Goal').fill('Verify the selected specialist team persists through automation creation.')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Show advanced settings', exact: true }).click()
    await page.getByRole('button', { name: /General/i }).click()
    await page.getByRole('button', { name: /Explore/i }).click()
    await page.getByRole('button', { name: 'Create automation', exact: true }).click()
    await page.getByRole('dialog', { name: /Specialist team check/ }).waitFor()

    const payload = await page.evaluate(async () => {
      return window.coworkApi.automation.list()
    })

    assert.deepEqual(payload.automations[0]?.preferredAgentNames, ['general', 'explore'])
  } finally {
    await cleanup()
  }
})

test('archived automations are hidden until requested and can be restored', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    await page.getByRole('button', { name: 'Automations', exact: true }).click()

    await createWeeklyAutomation(
      page,
      'Archive recovery check',
      'Verify archived automations are not lost from the board.',
    )
    await page.getByRole('dialog', { name: /Archive recovery check/ }).waitFor()
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await page.getByRole('button', { name: 'Restore', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Close automation details' }).click()

    await page.getByRole('button', { name: 'Show archived (1)', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /Archive recovery check/ }).count(), 0)

    await page.getByRole('button', { name: 'Show archived (1)', exact: true }).click()
    await page.getByRole('button', { name: /Archive recovery check/ }).waitFor()
    await page.getByRole('button', { name: /Archive recovery check/ }).click()
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor()

    const payload = await page.evaluate(async () => {
      return window.coworkApi.automation.list()
    })

    assert.equal(payload.automations[0]?.title, 'Archive recovery check')
    assert.notEqual(payload.automations[0]?.status, 'archived')
  } finally {
    await cleanup()
  }
})
