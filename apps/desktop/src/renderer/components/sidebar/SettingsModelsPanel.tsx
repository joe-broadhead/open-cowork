import { useEffect, useMemo, useState } from 'react'
import { SMALL_MODEL_USE_MAIN, type EffectiveAppSettings, type PublicAppConfig } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { Badge, Button, Card, Input } from '../ui'
import { credentialFieldIsSecret, isCredentialMask } from '../provider/credential-merge'
import { ProviderAuthControls } from '../provider/ProviderAuthControls'
import {
  fieldLabelCls,
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
  mode = 'model',
}: {
  config: PublicAppConfig
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
  updateProviderCredential: (providerId: string, key: string, value: string) => void
  onConfigRefreshed: (next: PublicAppConfig) => void
  onPersistSettings: () => Promise<boolean>
  mode?: 'model' | 'advanced'
}) {
  const provider = config.providers.available.find((entry) => entry.id === settings.effectiveProviderId) || null
  const models = useMemo(() => provider?.models || [], [provider])
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
      {mode === 'advanced' && config.auth.enabled ? (
        <Card className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-text">{t('settings.models.googleSignIn', 'Google sign-in')}</div>
              <div className="text-2xs text-text-muted leading-relaxed mt-1">
                {t('settings.models.googleSignInDescription', 'Sign out to force a fresh Google consent flow when this build adds new Workspace or Gemini scopes.')}
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              loading={signingOutGoogle}
              onClick={() => void handleGoogleSignOut()}
              className="shrink-0"
            >
              {signingOutGoogle
                ? t('settings.models.signingOutGoogle', 'Signing out...')
                : t('settings.models.signOutGoogle', 'Sign out')}
            </Button>
          </div>
        </Card>
      ) : null}

      {mode === 'model' ? (
        <>
          <div id="settings-model-provider" className="flex flex-col gap-3 scroll-mt-4">
            <span className={sectionLabelCls}>{t('settings.models.provider', 'Provider')}</span>
            <div className="grid grid-cols-2 gap-3">
              {config.providers.available.map((entry) => {
                const active = settings.effectiveProviderId === entry.id
                const nextModelId = entry.id === settings.effectiveProviderId
                  ? settings.selectedModelId || settings.effectiveModel || entry.defaultModel || entry.models[0]?.id || ''
                  : entry.defaultModel || entry.models[0]?.id || ''
                return (
                  <Card
                    key={entry.id}
                    interactive
                    padding="sm"
                    aria-pressed={active}
                    className="settings-choice-card"
                    onClick={() => update({
                      selectedProviderId: entry.id,
                      selectedModelId: nextModelId,
                      selectedSmallModelId: smallModelFollowsMainModel ? SMALL_MODEL_USE_MAIN : null,
                      effectiveProviderId: entry.id,
                      effectiveModel: nextModelId,
                      effectiveSmallModel: smallModelFollowsMainModel ? nextModelId : entry.smallModel || nextModelId,
                    })}
                  >
                    <div className="text-xs font-semibold text-text">{entry.name}</div>
                    <div className="text-2xs text-text-muted mt-1 leading-relaxed">{entry.description}</div>
                    {typeof entry.connected === 'boolean' ? (
                      <div className="text-2xs text-text-muted mt-2">
                        {entry.connected ? t('settings.models.connected', 'Signed in') : t('settings.models.notConnected', 'Not signed in')}
                      </div>
                    ) : null}
                  </Card>
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
                <Card className="flex flex-col gap-4">
                  {provider.credentials.map((credential) => {
                    const credentialIsSecret = credentialFieldIsSecret(credential)
                    return (
                      <div key={credential.key} className="flex flex-col gap-1.5">
                        <span className={fieldLabelCls}>{credential.label}</span>
                        <Input
                          size="sm"
                          type={credentialIsSecret ? 'password' : 'text'}
                          aria-label={credential.label}
                          value={providerCredentials[credential.key] || ''}
                          onFocus={() => {
                            if (credentialIsSecret && isCredentialMask(providerCredentials[credential.key])) {
                              updateProviderCredential(provider.id, credential.key, '')
                            }
                          }}
                          onChange={(event) => updateProviderCredential(provider.id, credential.key, event.target.value)}
                          placeholder={credential.placeholder}
                        />
                        <span className="text-2xs text-text-muted">{credential.description}</span>
                      </div>
                    )
                  })}
                </Card>
              ) : null}
              <Card id="settings-model-test" className="flex flex-col gap-4 scroll-mt-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold text-text">{t('settings.models.testConnection', 'Test connection')}</div>
                    <div className="mt-1 text-2xs leading-relaxed text-text-muted">
                      {t('settings.models.testConnectionDescription', 'Validate the selected provider credentials before restarting the app runtime.')}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    disabledReason={t('settings.models.testConnectionPending', 'Connection testing is wired in the onboarding validation work.')}
                  >
                    {t('settings.models.testConnection', 'Test connection')}
                  </Button>
                </div>
              </Card>
            </div>
          ) : null}

          {provider && models.length === 0 && (
            <div id="settings-model-primary" className="flex flex-col gap-3 scroll-mt-4">
              <span className={sectionLabelCls}>{t('settings.models.model', 'Model')}</span>
              <Input
                size="sm"
                type="text"
                aria-label={t('settings.models.model', 'Model')}
                value={settings.effectiveModel || settings.selectedModelId || ''}
                onChange={(event) => updateMainModel(event.target.value)}
                placeholder={t('setup.modelIdPlaceholder', 'Model ID')}
              />
              <span className="text-2xs text-text-muted px-1">
                {t('setup.runtimeModelsHint', 'This provider uses OpenCode\'s live model catalog after the runtime starts.')}
              </span>
            </div>
          )}

          {models.length > 0 && (
            <div id="settings-model-primary" className="flex flex-col gap-3 scroll-mt-4">
              <div className="flex items-center justify-between gap-2">
                <span className={sectionLabelCls}>
                  {t('settings.models.model', 'Model')}
                  <span className="ms-2 text-text-muted font-normal">
                    {filteredModels.length === models.length
                      ? `${models.length}`
                      : `${filteredModels.length} / ${models.length}`}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  loading={refreshingProviderId === provider?.id}
                  onClick={() => void handleRefreshCatalog()}
                  title={t('settings.models.refreshTitle', 'Refresh the dynamic model catalog')}
                >
                  {refreshingProviderId === provider?.id ? t('settings.models.refreshing', 'Refreshing...') : t('settings.models.refresh', 'Refresh')}
                </Button>
              </div>
              {useListView && (
                <Input
                  size="sm"
                  type="text"
                  leftIcon="search"
                  clearable
                  value={modelQuery}
                  onClear={() => setModelQuery('')}
                  onChange={(event) => setModelQuery(event.target.value)}
                  placeholder={t('settings.models.search', 'Search {{count}} models...', { count: String(models.length) })}
                />
              )}
              {useListView ? (
                <div className="settings-model-list">
                  {filteredModels.length === 0 ? (
                    <div className="px-3 py-6 text-xs text-text-muted text-center">{t('settings.models.noMatches', 'No models match this search.')}</div>
                  ) : (
                    filteredModels.map((model, index) => {
                      const isActive = settings.effectiveModel === model.id
                      const showFeaturedBoundary =
                        hasFeatured && index > 0 && filteredModels[index - 1]!.featured && !model.featured
                      return (
                        <div key={model.id}>
                          {showFeaturedBoundary && (
                            <div className="px-3 py-1 text-2xs uppercase tracking-[0.08em] text-text-muted bg-surface-hover">
                              {t('settings.models.allModels', 'All models')}
                            </div>
                          )}
                          <Card
                            interactive
                            padding="sm"
                            aria-pressed={isActive}
                            className="settings-model-list-option"
                            onClick={() => updateMainModel(model.id)}
                          >
                            <div className="flex items-baseline gap-2">
                              <span className="text-xs font-medium text-text truncate">{model.name}</span>
                              {model.featured ? (
                                <Badge tone="accent" className="settings-featured-badge">
                                  {t('settings.models.featured', 'Featured')}
                                </Badge>
                              ) : null}
                              {formatContextLength(model.contextLength) ? (
                                <span className="shrink-0 text-2xs text-text-muted">
                                  {formatContextLength(model.contextLength)}
                                </span>
                              ) : null}
                            </div>
                            <div className="text-2xs text-text-muted font-mono truncate">{model.id}</div>
                            {model.description ? (
                              <div className="text-2xs text-text-muted mt-0.5 line-clamp-2">{model.description}</div>
                            ) : null}
                          </Card>
                        </div>
                      )
                    })
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {filteredModels.map((model) => (
                    <Card
                      key={model.id}
                      interactive
                      padding="sm"
                      aria-pressed={settings.effectiveModel === model.id}
                      className="settings-choice-card"
                      onClick={() => updateMainModel(model.id)}
                    >
                      <div className="text-xs font-semibold text-text">{model.name}</div>
                      {model.description ? <div className="text-2xs text-text-muted mt-1">{model.description}</div> : null}
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      ) : null}

      {mode === 'advanced' && provider ? (
        <div id="settings-advanced-small-model" className="flex flex-col gap-3 scroll-mt-4">
          <div>
            <span className={sectionLabelCls}>{t('settings.models.smallModel', 'Small model')}</span>
            <div className="text-2xs text-text-muted mt-1 leading-relaxed">
              {t('settings.models.smallModelDescription', 'OpenCode uses this for lightweight work such as thread titles. Leave it empty to use the provider default, or the selected chat model when no default is configured.')}
            </div>
          </div>
          <Card>
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1.5">
                <span className={fieldLabelCls}>{t('settings.models.smallModelId', 'Model ID')}</span>
                <Input
                  size="sm"
                  type="text"
                  list={models.length > 0 ? 'open-cowork-small-model-options' : undefined}
                  aria-label={t('settings.models.smallModelId', 'Model ID')}
                  value={selectedSmallModelId}
                  onChange={(event) => updateSmallModel(event.target.value)}
                  placeholder={providerSmallModelId || mainModelId || t('settings.models.sameAsMainModel', 'Same as main model')}
                />
              </div>
              {models.length > 0 ? (
                <datalist id="open-cowork-small-model-options">
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                </datalist>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 text-2xs text-text-muted">
                  {smallModelUsesMainModel
                    ? t('settings.models.smallModelUsingMain', 'Using the selected chat model.')
                    : smallModelUsesProviderDefault
                      ? t('settings.models.smallModelUsingProviderDefault', 'Using provider default {{model}} for lightweight SDK calls.', { model: effectiveSmallModel })
                      : t('settings.models.smallModelUsingCustom', 'Using {{model}} for lightweight SDK calls.', { model: effectiveSmallModel })}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={useMainModelForSmallModel}
                  className="shrink-0"
                >
                  {t('settings.models.useMainModel', 'Use main model')}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  )
}
