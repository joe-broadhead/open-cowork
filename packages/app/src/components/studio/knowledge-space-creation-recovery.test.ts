import { knowledgeSpaceIdFromCreationId } from '@open-cowork/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  persistNewSpaceCreationProgress,
  readNewSpaceCreationProgress,
} from './knowledge-space-creation-recovery'

const WORKSPACE_ID = 'local'
const CREATION_ID = '00000000-0000-4000-8000-000000000001'
const STORAGE_KEY = 'open-cowork.knowledge.new-space.v1.local'

describe('Knowledge Space creation recovery', () => {
  beforeEach(() => window.localStorage.clear())

  it('round-trips valid progress and requires authoritative reconciliation after hydration', () => {
    persistNewSpaceCreationProgress({
      workspaceId: WORKSPACE_ID,
      creationId: CREATION_ID,
      name: 'Onboarding',
      visibility: 'company',
      spaceId: knowledgeSpaceIdFromCreationId(CREATION_ID),
      proposalId: 'proposal:onboarding',
    }, WORKSPACE_ID)

    expect(readNewSpaceCreationProgress(WORKSPACE_ID)).toEqual({
      workspaceId: WORKSPACE_ID,
      creationId: CREATION_ID,
      name: 'Onboarding',
      visibility: 'company',
      spaceId: knowledgeSpaceIdFromCreationId(CREATION_ID),
      proposalId: 'proposal:onboarding',
      needsReconciliation: true,
    })
  })

  it('discards malformed or uncorrelated persisted state', () => {
    window.localStorage.setItem(STORAGE_KEY, '{invalid')
    expect(readNewSpaceCreationProgress(WORKSPACE_ID)).toBeNull()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      workspaceId: WORKSPACE_ID,
      creationId: CREATION_ID,
      name: 'Onboarding',
      visibility: 'company',
      spaceId: 'space:someone-else',
    }))
    expect(readNewSpaceCreationProgress(WORKSPACE_ID)).toBeNull()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
