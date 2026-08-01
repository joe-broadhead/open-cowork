import { describe, expect, it } from 'vitest'
import {
  composerPreferencesFromHomeOptions,
  homePromptOptionsForRuntime,
  previousHomeComposerPreferences,
} from './home-prompt-options'

const session = {
  composerModelId: 'anthropic/previous-model',
  composerReasoningVariant: 'high',
}

describe('Home prompt option projections', () => {
  it('separates persistent composer preferences from one-shot runtime options', () => {
    const options = {
      modelId: 'openai/new-model',
      variant: 'xhigh',
      workspaceId: 'workspace-2',
    }

    expect(composerPreferencesFromHomeOptions(options)).toEqual({
      modelId: 'openai/new-model',
      reasoningVariant: 'xhigh',
    })
    expect(homePromptOptionsForRuntime(options)).toEqual({
      variant: 'xhigh',
      workspaceId: 'workspace-2',
    })
  })

  it('restores only preferences changed by the failed save', () => {
    expect(previousHomeComposerPreferences(session, { modelId: null })).toEqual({
      modelId: 'anthropic/previous-model',
    })
    expect(previousHomeComposerPreferences(session, { reasoningVariant: null })).toEqual({
      reasoningVariant: 'high',
    })
    expect(previousHomeComposerPreferences(undefined, {
      modelId: null,
      reasoningVariant: null,
    })).toEqual({
      modelId: null,
      reasoningVariant: null,
    })
  })

  it('preserves explicit clears while omitting untouched fields', () => {
    expect(composerPreferencesFromHomeOptions({ modelId: null })).toEqual({ modelId: null })
    expect(composerPreferencesFromHomeOptions({ variant: null })).toEqual({ reasoningVariant: null })
    expect(composerPreferencesFromHomeOptions({})).toEqual({})
    expect(previousHomeComposerPreferences(session, {})).toEqual({})
  })
})
