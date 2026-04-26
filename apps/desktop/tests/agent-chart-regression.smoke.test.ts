import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'

async function waitForRuntimeReady(page: Parameters<typeof waitForAppShell>[0], timeout = 20_000) {
  await page.evaluate(async (maxWaitMs) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < maxWaitMs) {
      const status = await window.coworkApi.runtime.status()
      if (status.ready) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('Timed out waiting for runtime to become ready')
  }, timeout)
}

test('chart specialist survives runtime rebuild and chart rendering still works', async () => {
  const { page, cleanup } = await launchSmokeApp()
  const agentName = `chart-specialist-${randomUUID().slice(0, 8)}`
  let created = false

  try {
    await waitForAppShell(page)
    await waitForRuntimeReady(page)

    const before = await page.evaluate(async () => {
      const [skills, runtimeAgents] = await Promise.all([
        window.coworkApi.capabilities.skills(),
        window.coworkApi.agents.runtime(),
      ])
      return {
        skillNames: skills.map((skill) => skill.name),
        runtimeAgentNames: runtimeAgents.map((agent) => agent.name),
      }
    })

    assert.ok(before.skillNames.includes('chart-creator'))
    assert.ok(before.runtimeAgentNames.includes('charts'))

    await page.evaluate(async (name) => {
      await window.coworkApi.agents.create({
        scope: 'machine',
        directory: null,
        name,
        description: 'Create charts from structured data.',
        instructions: 'Load the chart-creator skill before answering.',
        skillNames: ['chart-creator'],
        toolIds: ['charts'],
        enabled: true,
        color: 'info',
      })
    }, agentName)
    created = true

    await waitForRuntimeReady(page)

    const after = await page.evaluate(async (name) => {
      const [skills, customAgents, runtimeAgents, svg] = await Promise.all([
        window.coworkApi.capabilities.skills(),
        window.coworkApi.agents.list(),
        window.coworkApi.agents.runtime(),
        window.coworkApi.chart.renderSvg({
          $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
          data: {
            values: [
              { day: 'Sunday', value: 10 },
              { day: 'Monday', value: 14 },
              { day: 'Tuesday', value: 12 },
            ],
          },
          mark: 'line',
          encoding: {
            x: { field: 'day', type: 'ordinal' },
            y: { field: 'value', type: 'quantitative' },
          },
        }),
      ])

      return {
        skillNames: skills.map((skill) => skill.name),
        customAgentNames: customAgents.map((agent) => agent.name),
        runtimeAgentNames: runtimeAgents.map((agent) => agent.name),
        svg,
        createdAgentVisible: customAgents.some((agent) => agent.name === name),
        runtimeAgentVisible: runtimeAgents.some((agent) => agent.name === name),
      }
    }, agentName)

    assert.ok(after.skillNames.includes('chart-creator'))
    assert.equal(after.createdAgentVisible, true)
    assert.equal(after.runtimeAgentVisible, true)
    assert.match(after.svg, /<svg[\s>]/)
  } finally {
    if (created) {
      await page.evaluate(async (name) => {
        const confirmation = await window.coworkApi.confirm.requestDestructive({
          action: 'agent.remove',
          target: { scope: 'machine', name, directory: null },
        })
        await window.coworkApi.agents.remove(
          { scope: 'machine', name, directory: null },
          confirmation.token,
        )
      }, agentName).catch(() => {})
      await waitForRuntimeReady(page).catch(() => {})
    }

    await cleanup()
  }
})
