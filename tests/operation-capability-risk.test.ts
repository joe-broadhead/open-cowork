import test from 'node:test'
import assert from 'node:assert/strict'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { listCapabilityRiskMetadata } from '../apps/desktop/src/main/operation-capability-risk.ts'

test('operation capability risk metadata covers native tools, configured tools, and linked skills', () => {
  clearConfigCaches()
  try {
    const risks = listCapabilityRiskMetadata()
    const byCapability = new Map(risks.map((entry) => [entry.capabilityId, entry]))

    assert.equal(byCapability.get('native:bash')?.risk, 'high')
    assert.equal(byCapability.get('native:bash')?.writeCapable, true)
    assert.equal(byCapability.get('native:bash')?.approvalRequired, true)

    const chartTool = risks.find((entry) => entry.capabilityId === 'tool:charts' && entry.toolPattern === 'mcp__charts__*')
    assert.equal(chartTool?.risk, 'low')
    assert.equal(chartTool?.writeCapable, false)

    const skillBuilderTool = risks.find((entry) => entry.capabilityId === 'tool:skills' && entry.toolPattern === 'mcp__skills__save_skill_bundle')
    assert.equal(skillBuilderTool?.risk, 'high')
    assert.equal(skillBuilderTool?.writeCapable, true)
    assert.equal(skillBuilderTool?.approvalRequired, true)

    assert.equal(byCapability.get('skill:chart-creator')?.risk, 'low')
    assert.equal(byCapability.get('skill:skill-creator')?.risk, 'high')
  } finally {
    clearConfigCaches()
  }
})
