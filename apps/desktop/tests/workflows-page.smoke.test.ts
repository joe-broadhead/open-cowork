import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

function seedWorkflow(dataRoot: string) {
  const db = new DatabaseSync(`${dataRoot}/workflows.sqlite`)
  const id = randomUUID()
  const now = new Date().toISOString()
  try {
    db.exec(`
      pragma journal_mode = WAL;
      create table if not exists workflow_meta (
        key text primary key,
        value text not null
      );
      create table if not exists workflows (
        id text primary key,
        title text not null,
        instructions text not null,
        agent_name text not null,
        skill_names_json text not null,
        tool_ids_json text not null,
        steps_json text not null default '[]',
        status text not null,
        project_directory text,
        draft_session_id text,
        triggers_json text not null,
        created_at text not null,
        updated_at text not null,
        next_run_at text,
        last_run_at text,
        latest_run_id text,
        latest_run_status text,
        latest_run_session_id text,
        latest_run_summary text
      );
      create table if not exists workflow_runs (
        id text primary key,
        workflow_id text not null,
        session_id text,
        trigger_type text not null,
        trigger_payload_json text,
        status text not null,
        title text not null,
        summary text,
        error text,
        created_at text not null,
        started_at text,
        finished_at text
      );
      create index if not exists idx_workflow_runs_workflow on workflow_runs(workflow_id, created_at);
      create index if not exists idx_workflows_due on workflows(status, next_run_at);
    `)
    db.prepare('insert into workflow_meta (key, value) values (?, ?)').run('schema_version', '1')
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
