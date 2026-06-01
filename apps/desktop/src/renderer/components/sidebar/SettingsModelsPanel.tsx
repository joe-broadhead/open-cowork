import { useEffect, useMemo, useState } from 'react'
import { SMALL_MODEL_USE_MAIN, type EffectiveAppSettings, type PublicAppConfig } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { credentialFieldIsSecret, isCredentialMask } from '../provider/credential-merge'
import { ProviderAuthControls } from '../provider/ProviderAuthControls'
import {
  fieldLabelCls,
  inputCls,
  panelCardCls,
  sectionLabelCls,
} from './settings-panel-styles'

const MODEL_LIST_THRESHOLD = 20

function formatContextLength(tokens?: number): string | null {
  if (!tokens || !Number.isFinite(tokens)) return null
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M ctx`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`
  return `${tokens} ctx`
}

export function ModelsPanel({
  config,
  settings,
  update,
  updateProviderCredential,
  onConfigRefreshed,
  onPersistSettings,
}: {
  config: PublicAppConfig
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
  updateProviderCredential: (providerId: string, key: string, value: string) => void
  onConfigRefreshed: (next: PublicAppConfig) => void
  onPersistSettings: () => Promise<boolean>
}) {
  const provider = config.providers.available.find((entry) => entry.id === settings.effectiveProviderId) || null
  const models = provider?.models || []
  const providerCredentials = settings.effectiveProviderId
    ? (settings.providerCredentials[settings.effectiveProviderId] || {})
    : {}

  const [modelQuery, setModelQuery] = useState('')
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null)
  const [signingOutGoogle, setSigningOutGoogle] = useState(false)

  useEffect(() => { setModelQuery('') }, [settings.effectiveProviderId])

  const useListView = models.length > MODEL_LIST_THRESHOLD
  const hasFeatured = models.some((model) => model.featured)
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase()
    if (!query) return models
    return models.filter((model) => {
      const haystack = `${model.id} ${model.name} ${model.description || ''}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [models, modelQuery])

  const handleRefreshCatalog = async () => {
    if (!provider) return
    setRefreshingProviderId(provider.id)
    try {
      await window.coworkApi.app.refreshProviderCatalog(provider.id)
      const next = await window.coworkApi.app.config()
      onConfigRefreshed(next)
    } finally {
      setRefreshingProviderId(null)
    }
  }

  const handleGoogleSignOut = async () => {
    setSigningOutGoogle(true)
    try {
      await window.coworkApi.auth.logout()
    } finally {
      setSigningOutGoogle(false)
    }
  }

  const rawSelectedSmallModelId = settings.selectedSmallModelId || null
  const smallModelFollowsMainModel = rawSelectedSmallModelId === SMALL_MODEL_USE_MAIN
  const selectedSmallModelId = smallModelFollowsMainModel ? '' : rawSelectedSmallModelId || ''
  const mainModelId = settings.effectiveModel || settings.selectedModelId || ''
  const providerSmallModelId = provider?.smallModel || ''
  const effectiveSmallModel = settings.effectiveSmallModel || providerSmallModelId || mainModelId
  const smallModelUsesMainModel = effectiveSmallModel === mainModelId
  const smallModelUsesProviderDefault = !selectedSmallModelId && !!providerSmallModelId && effectiveSmallModel === providerSmallModelId
  const updateMainModel = (modelId: string) => update({
    selectedModelId: modelId,
    effectiveModel: modelId,
    ...(smallModelFollowsMainModel || (!settings.selectedSmallModelId && !providerSmallModelId) ? { effectiveSmallModel: modelId } : {}),
  })
  const updateSmallModel = (modelId: string) => {
    const trimmed = modelId.trim()
    update({
      selectedSmallModelId: trimmed || null,
      effectiveSmallModel: trimmed || providerSmallModelId || mainModelId || null,
    })
  }
  const useMainModelForSmallModel = () => update({
    selectedSmallModelId: SMALL_MODEL_USE_MAIN,
    effectiveSmallModel: mainModelId || null,
  })

  const persistBeforeProviderAuth = async () => {
    const persisted = await onPersistSettings()
    if (!persisted) return false
    if (!provider || provider.models.length > 0 || mainModelId.trim()) return true
    const status = await window.coworkApi.runtime.restart()
    return status.ready
  }

  return (
    <div className="flex flex-col gap-5">
      {config.auth.enabled ? (
        <div className={panelCardCls}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[12px] font-semibold text-text">{t('settings.models.googleSignIn', 'Google sign-in')}</div>
              <div className="text-[11px] text-text-muted leading-relaxed mt-1">
                {t('settings.models.googleSignInDescription', 'Sign out to force a fresh Google consent flow when this build adds new Workspace or Gemini scopes.')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleGoogleSignOut()}
              disabled={signingOutGoogle}
              className="shrink-0 px-3 py-2 rounded-xl border border-border-subtle text-[12px] font-semibold text-text cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait"
            >
              {signingOutGoogle
                ? t('settings.models.signingOutGoogle', 'Signing out...')
                : t('settings.models.signOutGoogle', 'Sign out')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <span className={sectionLabelCls}>{t('settings.models.provider', 'Provider')}</span>
        <div className="grid grid-cols-2 gap-3">
          {config.providers.available.map((entry) => {
            const nextModelId = entry.id === settings.effectiveProviderId
              ? settings.selectedModelId || settings.effectiveModel || entry.defaultModel || entry.models[0]?.id || ''
              : entry.defaultModel || entry.models[0]?.id || ''
            return (
              <button
                key={entry.id}
                onClick={() => update({
                  selectedProviderId: entry.id,
                  selectedModelId: nextModelId,
                  selectedSmallModelId: smallModelFollowsMainModel ? SMALL_MODEL_USE_MAIN : null,
                  effectiveProviderId: entry.id,
                  effectiveModel: nextModelId,
                  effectiveSmallModel: smallModelFollowsMainModel ? nextModelId : entry.smallModel || nextModelId,
                })}
                className="text-start rounded-2xl border p-3 transition-colors cursor-pointer"
                style={{
                  background: settings.effectiveProviderId === entry.id ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'var(--color-elevated)',
                  borderColor: settings.effectiveProviderId === entry.id ? 'var(--color-accent)' : 'var(--color-border-subtle)',
                }}
              >
                <div className="text-[12px] font-semibold text-text">{entry.name}</div>
                <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{entry.description}</div>
                {typeof entry.connected === 'boolean' ? (
                  <div className="text-[10px] text-text-muted mt-2">
                    {entry.connected ? t('settings.models.connected', 'Signed in') : t('settings.models.notConnected', 'Not signed in')}
                  </div>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>

      {provider ? (
        <div className="flex flex-col gap-3">
          <span className={sectionLabelCls}>{t('settings.models.authentication', 'Authentication')}</span>
          <ProviderAuthControls
            providerId={provider.id}
            providerName={provider.name}
            connected={provider.connected}
            onBeforeAuthorize={persistBeforeProviderAuth}
            onAuthUpdated={async () => {
              const nextConfig = await window.coworkApi.app.config()
              onConfigRefreshed(nextConfig)
              const refreshedProvider = nextConfig.providers.available.find((entry) => entry.id === provider.id) || null
              if (refreshedProvider?.defaultModel) {
                update({
                  selectedModelId: refreshedProvider.defaultModel,
                  effectiveModel: refreshedProvider.defaultModel,
                })
              }
            }}
          />

          {provider.credentials.length ? (
            <div className={panelCardCls}>
              {provider.credentials.map((credential) => {
                const credentialIsSecret = credentialFieldIsSecret(credential)
                return (
                  <label key={credential.key} className="flex flex-col gap-1.5">
                    <span className={fieldLabelCls}>{credential.label}</span>
                    <input
                      type={credentialIsSecret ? 'password' : 'text'}
                      value={providerCredentials[credential.key] || ''}
                      onFocus={() => {
                        if (credentialIsSecret && isCredentialMask(providerCredentials[credential.key])) {
                          updateProviderCredential(provider.id, credential.key, '')
                        }
                      }}
                      onChange={(event) => updateProviderCredential(provider.id, credential.key, event.target.value)}
                      placeholder={credential.placeholder}
                      className={inputCls}
                    />
                    <span className="text-[10px] text-text-muted">{credential.description}</span>
                  </label>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {provider && models.length === 0 && (
        <div className="flex flex-col gap-3">
          <span className={sectionLabelCls}>{t('settings.models.model', 'Model')}</span>
          <input
            type="text"
            value={settings.effectiveModel || settings.selectedModelId || ''}
            onChange={(event) => updateMainModel(event.target.value)}
            placeholder={t('setup.modelIdPlaceholder', 'Model ID')}
            className={inputCls}
          />
          <span className="text-[10px] text-text-muted px-1">
            {t('setup.runtimeModelsHint', 'This provider uses OpenCode\'s live model catalog after the runtime starts.')}
          </span>
        </div>
      )}

      {models.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className={sectionLabelCls}>
              {t('settings.models.model', 'Model')}
              <span className="ms-2 text-text-muted font-normal">
                {filteredModels.length === models.length
                  ? `${models.length}`
                  : `${filteredModels.length} / ${models.length}`}
              </span>
            </span>
            <button
              type="button"
              onClick={handleRefreshCatalog}
              disabled={refreshingProviderId === provider?.id}
              className="text-[11px] px-2 py-1 rounded-full border border-border-subtle text-text-muted hover:text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              title={t('settings.models.refreshTitle', 'Refresh the dynamic model catalog')}
            >
              {refreshingProviderId === provider?.id ? t('settings.models.refreshing', 'Refreshing…') : t('settings.models.refresh', 'Refresh')}
            </button>
          </div>
          {useListView && (
            <input
              type="text"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              placeholder={t('settings.models.search', 'Search {{count}} models…', { count: String(models.length) })}
              className={inputCls}
            />
          )}
          {useListView ? (
            <div className="rounded-2xl border border-border-subtle overflow-hidden max-h-[420px] overflow-y-auto">
              {filteredModels.length === 0 ? (
                <div className="px-3 py-6 text-[12px] text-text-muted text-center">{t('settings.models.noMatches', 'No models match this search.')}</div>
              ) : (
                filteredModels.map((model, index) => {
                  const isActive = settings.effectiveModel === model.id
                  const showFeaturedBoundary =
                    hasFeatured && index > 0 && filteredModels[index - 1].featured && !model.featured
                  return (
                    <div key={model.id}>
                      {showFeaturedBoundary && (
                        <div className="px-3 py-1 text-[10px] uppercase tracking-[0.08em] text-text-muted bg-surface-hover">
                          {t('settings.models.allModels', 'All models')}
                        </div>
                      )}
                      <button
                        onClick={() => updateMainModel(model.id)}
                        className="w-full text-start px-3 py-2 border-b border-border-subtle last:border-b-0 cursor-pointer transition-colors"
                        style={{
                          background: isActive ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent',
                        }}
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="text-[12px] font-medium text-text truncate">{model.name}</span>
                          {model.featured && (
                            <span
                              className="shrink-0 text-[9px] uppercase tracking-[0.04em] px-1 py-px rounded"
                              style={{
                                color: 'var(--color-accent)',
                                background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                              }}
                            >
                              {t('settings.models.featured', 'Featured')}
                            </span>
                          )}
                          {formatContextLength(model.contextLength) && (
                            <span className="shrink-0 text-[10px] text-text-muted">
                              {formatContextLength(model.contextLength)}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-text-muted font-mono truncate">{model.id}</div>
                        {model.description && (
                          <div className="text-[11px] text-text-muted mt-0.5 line-clamp-2">{model.description}</div>
                        )}
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filteredModels.map((model) => (
                <button
                  key={model.id}
                  onClick={() => updateMainModel(model.id)}
                  className="rounded-2xl border px-3 py-3 text-start transition-colors cursor-pointer"
                  style={{
                    background: settings.effectiveModel === model.id ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'var(--color-elevated)',
                    borderColor: settings.effectiveModel === model.id ? 'var(--color-accent)' : 'var(--color-border-subtle)',
                  }}
                >
                  <div className="text-[12px] font-semibold text-text">{model.name}</div>
                  {model.description ? <div className="text-[11px] text-text-muted mt-1">{model.description}</div> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {provider ? (
        <div className="flex flex-col gap-3">
          <div>
            <span className={sectionLabelCls}>{t('settings.models.smallModel', 'Small model')}</span>
            <div className="text-[11px] text-text-muted mt-1 leading-relaxed">
              {t('settings.models.smallModelDescription', 'OpenCode uses this for lightweight work such as thread titles. Leave it empty to use the provider default, or the selected chat model when no default is configured.')}
            </div>
          </div>
          <div className={panelCardCls}>
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabelCls}>{t('settings.models.smallModelId', 'Model ID')}</span>
                <input
                  type="text"
                  list={models.length > 0 ? 'open-cowork-small-model-options' : undefined}
                  value={selectedSmallModelId}
                  onChange={(event) => updateSmallModel(event.target.value)}
                  placeholder={providerSmallModelId || mainModelId || t('settings.models.sameAsMainModel', 'Same as main model')}
                  className={inputCls}
                />
              </label>
              {models.length > 0 ? (
                <datalist id="open-cowork-small-model-options">
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                </datalist>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 text-[10px] text-text-muted">
                  {smallModelUsesMainModel
                    ? t('settings.models.smallModelUsingMain', 'Using the selected chat model.')
                    : smallModelUsesProviderDefault
                      ? t('settings.models.smallModelUsingProviderDefault', 'Using provider default {{model}} for lightweight SDK calls.', { model: effectiveSmallModel })
                      : t('settings.models.smallModelUsingCustom', 'Using {{model}} for lightweight SDK calls.', { model: effectiveSmallModel })}
                </div>
                <button
                  type="button"
                  onClick={useMainModelForSmallModel}
                  className="shrink-0 text-[11px] px-2 py-1 rounded-full border border-border-subtle text-text-muted hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  {t('settings.models.useMainModel', 'Use main model')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
