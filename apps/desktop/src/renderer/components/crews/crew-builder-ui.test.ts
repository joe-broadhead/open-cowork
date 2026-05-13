import { describe, expect, it } from 'vitest'
import {
  draftFromCrewTemplate,
  validateCrewDraftForBuilder,
  type CrewAgentOption,
} from './crew-builder-ui'

function agent(name: string, disabled = false): CrewAgentOption {
  return {
    name,
    label: name,
    description: `${name} agent`,
    source: 'built-in',
    model: null,
    skills: [],
    tools: [],
    disabled,
    writeAccess: false,
  }
}

describe('crew builder ui helpers', () => {
  it('skips disabled agents and keeps template member assignments distinct when possible', () => {
    const draft = draftFromCrewTemplate('operations', [
      agent('plan', true),
      agent('explore'),
      agent('build'),
      agent('general'),
      agent('review'),
    ])

    expect(draft.members.map((member) => member.agentName)).toEqual(['explore', 'general', 'build', 'review'])
    expect(validateCrewDraftForBuilder(draft, [
      agent('plan', true),
      agent('explore'),
      agent('build'),
      agent('general'),
      agent('review'),
    ])).toEqual([])
  })

  it('rejects manually selected disabled agents from the loaded catalog', () => {
    const draft = draftFromCrewTemplate('operations')

    expect(validateCrewDraftForBuilder(draft, [
      agent('plan', true),
      agent('explore'),
      agent('build'),
      agent('general'),
    ])).toContain('plan is disabled in the loaded agent catalog.')
  })
})
