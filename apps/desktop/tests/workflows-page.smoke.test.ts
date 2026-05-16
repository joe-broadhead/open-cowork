import test from 'node:test'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

test('workflows page presents the thread-first workflow surface', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    await page.getByRole('button', { name: 'Workflows', exact: true }).click()

    await page.getByRole('heading', { name: 'Workflows', exact: true }).waitFor()
    await page.getByText('Save repeatable work from a Workflow Designer setup thread').waitFor()
    await page.getByRole('button', { name: 'Add workflow', exact: true }).first().waitFor()
    await page.getByText('No workflows yet').waitFor()
  } finally {
    await cleanup()
  }
})
