import { knowledgeSpaceIdFromCreationId } from '@open-cowork/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearNewSpaceCreationProgress,
  persistNewSpaceCreationProgress,
  readNewSpaceCreationProgress,
} from './knowledge-space-creation-recovery'
import { runNewSpaceCreationSingleFlight } from './knowledge-space-creation-runner'

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

  it('joins an active creation run and releases the lease after it settles', async () => {
    let resolve!: (value: number) => void
    const deferred = new Promise<number>((done) => { resolve = done })
    let runCount = 0
    const first = runNewSpaceCreationSingleFlight('single-flight-test', async () => {
      runCount += 1
      return deferred
    })
    const joined = runNewSpaceCreationSingleFlight('single-flight-test', async () => {
      runCount += 1
      return 99
    })

    expect(first.joined).toBe(false)
    expect(joined.joined).toBe(true)
    resolve(7)
    await expect(first.promise).resolves.toBe(7)
    await expect(joined.promise).resolves.toBe(7)
    expect(runCount).toBe(1)

    const next = runNewSpaceCreationSingleFlight('single-flight-test', async () => 11)
    expect(next.joined).toBe(false)
    await expect(next.promise).resolves.toBe(11)
  })

  it('does not let an obsolete completion clear a newer operation', () => {
    persistNewSpaceCreationProgress({
      workspaceId: WORKSPACE_ID,
      creationId: CREATION_ID,
      name: 'Newer Space',
      visibility: 'company',
    }, WORKSPACE_ID)

    clearNewSpaceCreationProgress('00000000-0000-4000-8000-000000000002', WORKSPACE_ID)
    expect(readNewSpaceCreationProgress(WORKSPACE_ID)?.creationId).toBe(CREATION_ID)
    clearNewSpaceCreationProgress(CREATION_ID, WORKSPACE_ID)
    expect(readNewSpaceCreationProgress(WORKSPACE_ID)).toBeNull()
  })
})
