import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderDescriptor } from '@open-cowork/shared'
import { t } from '../helpers/i18n'
import { mergeFetchedProviderCredentials } from './provider/credential-merge'
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
  const [loadedCredentialProviders, setLoadedCredentialProviders] = useState<Set<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirtyProviderCredentialKeys = useRef<Record<string, Set<string>>>({})
  const providerSelectionEdited = useRef(false)

  const markProviderCredentialDirty = (nextProviderId: string, key: string) => {
    const keys = dirtyProviderCredentialKeys.current[nextProviderId] || new Set<string>()
    keys.add(key)
    dirtyProviderCredentialKeys.current[nextProviderId] = keys
  }

  const mergeLoadedProviderCredentials = (nextProviderId: string, credentials: Record<string, string>) => {
    setProviderCredentials((current) => ({
      ...current,
      [nextProviderId]: mergeFetchedProviderCredentials(
        current[nextProviderId],
        credentials,
        dirtyProviderCredentialKeys.current[nextProviderId],
      ),
    }))
  }

  useEffect(() => {
    // Settings are loaded masked by default. The setup form requests only
    // the selected provider's credential bag below.
    let cancelled = false
    window.coworkApi.settings.get().then(async (settings) => {
      const initialProviderId = providers.some((provider) => provider.id === settings.selectedProviderId)
        ? settings.selectedProviderId
        : settings.effectiveProviderId || defaultProviderId
      const initialProvider = providers.find((provider) => provider.id === initialProviderId) || null
      const initialModelId = initialProvider?.models.some((model) => model.id === settings.selectedModelId)
        ? settings.selectedModelId || ''
        : settings.effectiveModel || initialProvider?.defaultModel || defaultModelId || initialProvider?.models[0]?.id || ''
      const initialCredentials = initialProviderId
        ? await window.coworkApi.settings.getProviderCredentials(initialProviderId)
        : {}
      if (cancelled) return
      if (!providerSelectionEdited.current) {
        setProviderId(initialProviderId)
        setModelId(initialModelId)
      }
      if (initialProviderId) {
        mergeLoadedProviderCredentials(initialProviderId, initialCredentials)
        setLoadedCredentialProviders((current) => new Set(current).add(initialProviderId))
      }
    }).catch((err) => {
      console.error('Failed to load setup settings:', err)
    })
    return () => { cancelled = true }
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

  useEffect(() => {
    if (!providerId || loadedCredentialProviders.has(providerId)) return
    let cancelled = false
    window.coworkApi.settings.getProviderCredentials(providerId).then((credentials) => {
      if (cancelled) return
      mergeLoadedProviderCredentials(providerId, credentials)
      setLoadedCredentialProviders((current) => new Set(current).add(providerId))
    }).catch((err) => {
      console.error('Failed to load provider credentials:', err)
    })
    return () => { cancelled = true }
  }, [loadedCredentialProviders, providerId])

  const selectedCredentials = providerId ? (providerCredentials[providerId] || {}) : {}
  const requiredCredentials = selectedProvider?.credentials.filter((credential) => credential.required !== false) || []
  const canContinue = Boolean(
    providerId
    && modelId.trim()
    && requiredCredentials.every((credential) => (selectedCredentials[credential.key] || '').trim()),
  )

  const updateCredential = (key: string, value: string) => {
    if (!providerId) return
    markProviderCredentialDirty(providerId, key)
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
    <div className="h-screen w-screen overflow-y-auto" style={{ background: 'var(--color-base)' }}>
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <div className="flex flex-col items-center gap-2">
          <div className="w-12 h-12 rounded-2xl bg-surface border border-border flex items-center justify-center">
            <span className="text-lg font-bold text-accent">O</span>
          </div>
          <h1 className="text-lg font-semibold text-text">
            {email
              ? t('setup.welcomeUser', 'Welcome, {{name}}', { name: email.split('@')[0] })
              : t('setup.welcomeGeneric', 'Welcome to {{brandName}}', { brandName })}
          </h1>
          <p className="text-[13px] text-text-muted text-center max-w-2xl">
            {t('setup.description', 'Choose the provider and model this {{brandName}} build should use by default.', { brandName })}
          </p>
        </div>

        <div className="mt-6 w-full flex flex-col gap-3">
          {providers.map((provider) => (
            <button
              key={provider.id}
              onClick={() => {
                providerSelectionEdited.current = true
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

          {selectedProvider && (
            <>
              <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1 mt-3">{t('settings.models.authentication', 'Authentication')}</span>
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

              <div className="w-full flex flex-col gap-3 mt-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">{t('setup.model', 'Model')}</span>
                {selectedProvider.models.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {selectedProvider.models.map((model) => (
                      <button
                        key={model.id}
                        onClick={() => setModelId(model.id)}
                        className="flex flex-col items-start gap-1 px-3.5 py-2.5 rounded-lg text-start cursor-pointer transition-all border"
                        style={{
                          background: modelId === model.id ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent',
                          borderColor: modelId === model.id ? 'var(--color-accent)' : 'transparent',
                        }}
                      >
                        <span
                          className="text-[12px] font-medium leading-snug w-full"
                          style={{ color: modelId === model.id ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}
                        >
                          {model.name}
                        </span>
                        {model.description ? (
                          <span className="text-[10px] text-text-muted leading-relaxed w-full line-clamp-2">
                            {model.description}
                          </span>
                        ) : null}
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
            </>
          )}

          {error ? (
            <p className="text-[12px] text-center" style={{ color: 'var(--color-red)' }}>{error}</p>
          ) : null}

          <button
            onClick={handleContinue}
            disabled={!canContinue || saving}
            className="w-full py-2.5 rounded-xl text-[13px] font-semibold cursor-pointer transition-all mt-2"
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
    </div>
  )
}
