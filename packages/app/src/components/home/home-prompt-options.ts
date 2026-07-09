import type { SessionComposerPreferences, SessionPromptOptions } from '@open-cowork/shared'

export type HomePromptOptions = SessionPromptOptions & {
  modelId?: string | null
}

export function homePromptOptionsForRuntime(options?: HomePromptOptions): SessionPromptOptions | undefined {
  if (!options) return undefined
  const runtimeOptions: SessionPromptOptions = {}
  if (options.variant) runtimeOptions.variant = options.variant
  if (options.workspaceId) runtimeOptions.workspaceId = options.workspaceId
  return Object.keys(runtimeOptions).length > 0 ? runtimeOptions : undefined
}

export function composerPreferencesFromHomeOptions(options?: HomePromptOptions): SessionComposerPreferences {
  const preferences: SessionComposerPreferences = {}
  if (!options) return preferences
  if (Object.prototype.hasOwnProperty.call(options, 'modelId')) {
    preferences.modelId = options.modelId ?? null
  }
  if (Object.prototype.hasOwnProperty.call(options, 'variant')) {
    preferences.reasoningVariant = options.variant ?? null
  }
  return preferences
}
