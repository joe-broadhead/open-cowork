import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSankeySpec } from '../mcps/charts/src/sankey.ts'

test('buildSankeySpec creates a Vega sankey spec with aggregated links and positioned nodes', () => {
  const spec = buildSankeySpec({
    data: [
      { stage_from: 'Leads', stage_to: 'Qualified', amount: 10 },
      { stage_from: 'Leads', stage_to: 'Qualified', amount: 5 },
      { stage_from: 'Qualified', stage_to: 'Won', amount: 8 },
      { stage_from: 'Qualified', stage_to: 'Lost', amount: 7 },
    ],
    source: 'stage_from',
    target: 'stage_to',
    value: 'amount',
    title: 'Pipeline Flow',
    width: 900,
    height: 480,
    nodeWidth: 18,
    nodePadding: 20,
  })

  assert.equal(spec.$schema, 'https://vega.github.io/schema/vega/v5.json')
  assert.equal(spec.width, 900)
  assert.equal(spec.height, 480)

  const nodes = spec.data[0]?.values as Array<Record<string, unknown>>
  const links = spec.data[1]?.values as Array<Record<string, unknown>>

  assert.equal(nodes.some((node) => node.label === 'Leads'), true)
  assert.equal(nodes.some((node) => node.label === 'Qualified'), true)
  assert.equal(nodes.some((node) => node.label === 'Won'), true)
  assert.equal(links.length, 3)

  const aggregatedLeadLink = links.find((link) => link.source === 'Leads' && link.target === 'Qualified')
  assert.ok(aggregatedLeadLink)
  assert.equal(aggregatedLeadLink.value, 15)
  assert.equal(typeof aggregatedLeadLink.path, 'string')
  assert.equal(typeof aggregatedLeadLink.width, 'number')
})
