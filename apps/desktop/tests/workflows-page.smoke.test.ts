import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setWorkflowDatabaseForTests } from '@open-cowork/runtime-host/workflow/workflow-store'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

function seedWorkflow(dataRoot: string) {
  const db = new DatabaseSync(`${dataRoot}/workflows.sqlite`)
  const id = randomUUID()
  const now = new Date().toISOString()
  try {
    setWorkflowDatabaseForTests(db)
    db.prepare(`
      insert into workflows (
        id,
        title,
        instructions,
        agent_name,
        skill_names_json,
        tool_ids_json,
        steps_json,
        status,
        project_directory,
        draft_session_id,
        triggers_json,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      'Smoke workflow',
      'Exercise the workflow run IPC path without requiring a real provider.',
      'missing-agent-smoke',
      '[]',
      '[]',
      JSON.stringify([{ id: 'step-1', title: 'Exercise workflow run IPC', detail: null }]),
      'active',
      null,
      null,
      JSON.stringify([{ id: 'manual', type: 'manual', enabled: true }]),
      now,
      now,
    )
    return id
  } finally {
    setWorkflowDatabaseForTests(null)
    db.close()
  }
}

test('workflows page presents the thread-first workflow surface', async () => {
  const { page, cleanup } = await launchSmokeApp()

  try {
    await waitForAppShell(page)
    await page.getByRole('button', { name: 'Playbooks', exact: true }).click()

    await page.getByRole('heading', { name: 'Playbooks', exact: true }).waitFor()
    await page.getByText('Save repeatable work from a Workflow Designer setup chat').waitFor()
    await page.getByRole('button', { name: 'Add playbook', exact: true }).first().waitFor()
    await page.getByText('No playbooks yet').waitFor()
  } finally {
    await cleanup()
  }
})

test('workflow run action crosses renderer, preload, main, and persisted run state', async () => {
  let workflowId = ''
  const { page, cleanup } = await launchSmokeApp({
    seedBeforeLaunch: ({ dataRoot }) => {
      workflowId = seedWorkflow(dataRoot)
    },
  })

  try {
    await waitForAppShell(page)
    await page.getByRole('button', { name: 'Playbooks', exact: true }).click()

    await page.getByRole('heading', { name: 'Playbooks', exact: true }).waitFor()
    await page.getByRole('heading', { name: 'Smoke workflow', exact: true }).waitFor()

    const runResult = await page.evaluate(async (id) => {
      try {
        return { ok: true, value: await window.coworkApi.workflows.runNow(id) }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }, workflowId)
    assert.equal(runResult.ok, true, `workflow run IPC failed: ${runResult.ok ? '' : runResult.message}`)

    await page.waitForFunction(
      async (id) => {
        const workflow = await window.coworkApi.workflows.get(id)
        return Boolean(workflow?.latestRunId && workflow.latestRunStatus)
      },
      workflowId,
      { timeout: 20_000 },
    )

    const detail = await page.evaluate(async (id) => window.coworkApi.workflows.get(id), workflowId)
    assert.ok(detail?.latestRunId, 'run-now must persist a workflow run')
    assert.ok(detail?.latestRunSessionId, 'run-now must attach the OpenCode session created for execution')
    assert.match(String(detail?.latestRunStatus), /queued|running|completed|failed/)
  } finally {
    await cleanup()
  }
})
