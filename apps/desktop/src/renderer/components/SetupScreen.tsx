import { useEffect, useMemo, useState } from 'react'
import type { ProviderDescriptor } from '@open-cowork/shared'
import { t } from '../helpers/i18n'
import { ProviderAuthControls } from './provider/ProviderAuthControls'

interface Props {
  brandName: string
  email?: string | null
  providers: ProviderDescriptor[]
  defaultProviderId: string | null
  defaultModelId: string | null
  onComplete: () => void
}

export function SetupScreen({
  brandName,
  email,
  providers,
  defaultProviderId,
  defaultModelId,
  onComplete,
}: Props) {
  const [providerId, setProviderId] = useState<string | null>(defaultProviderId)
  const [modelId, setModelId] = useState(defaultModelId || '')
  const [providerCredentials, setProviderCredentials] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // SetupScreen is a credential-editor surface — it prefills existing
    // values and lets the user append to them, so it needs the real
    // strings rather than the masked defaults returned by settings.get().
    window.coworkApi.settings.getWithCredentials().then((settings) => {
      const initialProviderId = providers.some((provider) => provider.id === settings.selectedProviderId)
        ? settings.selectedProviderId
        : settings.effectiveProviderId || defaultProviderId
      const initialProvider = providers.find((provider) => provider.id === initialProviderId) || null
      const initialModelId = initialProvider?.models.some((model) => model.id === settings.selectedModelId)
        ? settings.selectedModelId || ''
        : settings.effectiveModel || initialProvider?.defaultModel || defaultModelId || initialProvider?.models[0]?.id || ''
      setProviderId(initialProviderId)
      setModelId(initialModelId)
      setProviderCredentials(settings.providerCredentials || {})
    }).catch((err) => {
      console.error('Failed to load setup settings:', err)
    })
  }, [defaultModelId, defaultProviderId, providers])

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === providerId) || null,
    [providers, providerId],
  )

  useEffect(() => {
    if (!selectedProvider) return
    if (!modelId) {
      setModelId(selectedProvider.defaultModel || selectedProvider.models[0]?.id || defaultModelId || '')
    }
  }, [selectedProvider, modelId, defaultModelId])

  const selectedCredentials = providerId ? (providerCredentials[providerId] || {}) : {}
  const requiredCredentials = selectedProvider?.credentials.filter((credential) => credential.required !== false) || []
  const canContinue = Boolean(
    providerId
    && modelId.trim()
    && requiredCredentials.every((credential) => (selectedCredentials[credential.key] || '').trim()),
  )

  const updateCredential = (key: string, value: string) => {
    if (!providerId) return
    setProviderCredentials((current) => ({
      ...current,
      [providerId]: {
        ...(current[providerId] || {}),
        [key]: value,
      },
    }))
  }

  const persistSelectionAndRestart = async (modelOverride?: string, options: { allowMissingModel?: boolean } = {}) => {
    if (!providerId) return false
    const nextModelId = (modelOverride || modelId).trim()
    const hasRequiredCredentials = requiredCredentials.every((credential) => (selectedCredentials[credential.key] || '').trim())
    if ((!nextModelId && !options.allowMissingModel) || !hasRequiredCredentials) return false
    setSaving(true)
    setError(null)
    try {
      await window.coworkApi.settings.set({
        selectedProviderId: providerId,
        selectedModelId: nextModelId,
        providerCredentials: {
          [providerId]: selectedCredentials,
        },
      })
      // Reboot the runtime with the new credentials so a bad API key
      // surfaces here instead of silently during the user's first
      // prompt. If restart reports `ready: false`, show the actual
      // runtime error (wrong key, unreachable provider, etc.) and
      // leave the setup form open so the user can correct it.
      const status = await window.coworkApi.runtime.restart()
      if (!status.ready) {
        setError(status.error || t('setup.runtimeFailed', 'Runtime could not start with the provided credentials. Double-check your API key and try again.'))
        setSaving(false)
        return false
      }
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('setup.saveFailed', 'Failed to save settings'))
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleContinue = async () => {
    const ok = await persistSelectionAndRestart()
    if (ok) {
      onComplete()
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen w-screen" style={{ background: 'var(--color-base)' }}>
      <div className="flex flex-col items-center gap-6 max-w-md w-full px-6">
        <div className="flex flex-col items-center gap-2">
          <div className="w-12 h-12 rounded-2xl bg-surface border border-border flex items-center justify-center">
            <span className="text-lg font-bold text-accent">O</span>
          </div>
          <h1 className="text-lg font-semibold text-text">
            {email
              ? t('setup.welcomeUser', 'Welcome, {{name}}', { name: email.split('@')[0] })
              : t('setup.welcomeGeneric', 'Welcome to {{brandName}}', { brandName })}
          </h1>
          <p className="text-[13px] text-text-muted text-center">
            {t('setup.description', 'Choose the provider and model this {{brandName}} build should use by default.', { brandName })}
          </p>
        </div>

        <div className="w-full flex flex-col gap-2">
          {providers.map((provider) => (
            <button
              key={provider.id}
              onClick={() => {
                setProviderId(provider.id)
                setModelId(provider.defaultModel || provider.models[0]?.id || '')
              }}
              className="w-full text-start px-4 py-3 rounded-xl border transition-all cursor-pointer"
              style={{
                background: providerId === provider.id ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'var(--color-elevated)',
                borderColor: providerId === provider.id ? 'var(--color-accent)' : 'var(--color-border-subtle)',
              }}
            >
              <div className="text-[13px] font-medium" style={{ color: providerId === provider.id ? 'var(--color-accent)' : 'var(--color-text)' }}>
                {provider.name}
              </div>
              <div className="text-[11px] text-text-muted mt-0.5">{provider.description}</div>
            </button>
          ))}
        </div>

        {selectedProvider && (
          <div className="w-full flex flex-col gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">{t('settings.models.authentication', 'Authentication')}</span>
            <ProviderAuthControls
              providerId={providerId}
              providerName={selectedProvider.name}
              connected={selectedProvider.connected}
              disabled={!providerId || saving}
              onBeforeAuthorize={async () => persistSelectionAndRestart(undefined, { allowMissingModel: true })}
              onAuthUpdated={async () => {
                const authModelId = selectedProvider.defaultModel || modelId
                setModelId(authModelId)
              }}
            />
            {selectedProvider.credentials.length > 0 ? (
              <div className="flex flex-col gap-2.5 rounded-xl border border-border-subtle p-3.5" style={{ background: 'var(--color-elevated)' }}>
                {selectedProvider.credentials.map((credential) => (
                  <label key={credential.key} className="flex flex-col gap-1">
                    <span className="text-[11px] text-text-muted font-medium">{credential.label}</span>
                    <input
                      type={credential.secret ? 'password' : 'text'}
                      value={selectedCredentials[credential.key] || ''}
                      onChange={(event) => updateCredential(credential.key, event.target.value)}
                      placeholder={credential.placeholder}
                      className="w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors"
                    />
                    <span className="text-[10px] text-text-muted">{credential.description}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        )}

        {selectedProvider ? (
          <div className="w-full flex flex-col gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">{t('setup.model', 'Model')}</span>
            {selectedProvider.models.length > 0 ? (
              <div className="flex flex-col gap-1">
                {selectedProvider.models.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => setModelId(model.id)}
                    className="flex items-center justify-between px-3.5 py-2.5 rounded-lg text-start cursor-pointer transition-all border"
                    style={{
                      background: modelId === model.id ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent',
                      borderColor: modelId === model.id ? 'var(--color-accent)' : 'transparent',
                    }}
                  >
                    <span className="text-[12px]" style={{ color: modelId === model.id ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>{model.name}</span>
                    {model.description ? <span className="text-[10px] text-text-muted">{model.description}</span> : null}
                  </button>
                ))}
              </div>
            ) : (
              <input
                type="text"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                placeholder={t('setup.modelIdPlaceholder', 'Model ID')}
                className="w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors"
              />
            )}
            {selectedProvider.models.length === 0 ? (
              <span className="text-[10px] text-text-muted px-1">
                {t('setup.runtimeModelsHint', 'This provider uses OpenCode\'s live model catalog after the runtime starts.')}
              </span>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="text-[12px] text-center" style={{ color: 'var(--color-red)' }}>{error}</p>
        ) : null}

        <button
          onClick={handleContinue}
          disabled={!canContinue || saving}
          className="w-full py-2.5 rounded-xl text-[13px] font-semibold cursor-pointer transition-all"
          style={{
            background: canContinue ? 'var(--color-accent)' : 'var(--color-surface-hover)',
            color: canContinue ? 'var(--color-accent-foreground)' : 'var(--color-text-muted)',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? t('common.loading', 'Setting up...') : t('setup.continue', 'Get Started')}
        </button>
      </div>
    </div>
  )
}
