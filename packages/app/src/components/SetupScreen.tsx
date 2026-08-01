import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  createDisabledRuntimeToolingBridgeConsent,
  normalizeRuntimeToolingBridgeConsent,
  SETUP_INTENTS,
  type ProviderDescriptor,
  type RuntimeLoadingPhase,
  type RuntimeLoadingStatus,
  type RuntimeStatus,
  type SetupIntentId,
} from '@open-cowork/shared'
import { t } from '../helpers/i18n'
import { getDocsBaseUrl } from '../helpers/brand'
import { credentialFieldIsSecret, isCredentialMask, mergeFetchedProviderCredentials } from './provider/credential-merge'
import { useSessionStore } from '../stores/session'
import { LOCAL_WORKSPACE_ID } from '../stores/session-workspace-keys'
import { Badge, Button, Input } from '@open-cowork/ui'
import { BrandMark } from './BrandMark'
import { ConfirmDialog } from './ConfirmDialog'
import { RuntimeToolingBridgeConsentPanel } from './RuntimeToolingBridgeConsent'
import { SetupModelCatalog } from './SetupModelCatalog'

const ProviderAuthControls = lazy(() => import('./provider/ProviderAuthControls').then((module) => ({
  default: module.ProviderAuthControls,
})))

interface Props {
  brandName: string
  email?: string | null
  providers: ProviderDescriptor[]
  defaultProviderId: string | null
  defaultModelId: string | null
  onComplete: () => void
}

type ConnectionTestState =
  | { status: 'idle'; signature: null; message: string | null }
  | { status: 'testing'; signature: null; message: string | null }
  | { status: 'success'; signature: string; message: string }
  | { status: 'error'; signature: null; message: string }

const localIntent = SETUP_INTENTS.find((intent) => intent.id === 'desktop-local') || SETUP_INTENTS[0]!
const advancedIntents = SETUP_INTENTS.filter((intent) => intent.id !== 'desktop-local')

const phaseProgress: Record<RuntimeLoadingPhase, number> = {
  idle: 6,
  starting: 16,
  config: 34,
  'managed-server': 56,
  'connecting-events': 72,
  mcp: 86,
  ready: 100,
  error: 100,
}

function describeSetupLoadError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function setupActionErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error) || !error.message.trim()) return fallback
  return error.message.replace(
    /^Error invoking remote method '[^']+': (?:[A-Za-z][A-Za-z0-9]*Error: )?/,
    '',
  )
}

function reportSetupLoadError(error: unknown, scope: string) {
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `${scope}: ${describeSetupLoadError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'setup',
    })
  } catch {
    // Diagnostics are best-effort from a setup recovery path.
  }
}

async function resolveRuntimeProviderDefaultModel(providerId: string | null) {
  if (!providerId) return ''
  const providers = await window.coworkApi.provider.list()
  const provider = providers.find((entry) => entry.id === providerId || entry.name === providerId)
  const defaultModel = provider?.defaultModel?.trim()
  if (defaultModel) {
    const prefix = `${providerId}/`
    return defaultModel.startsWith(prefix) ? defaultModel.slice(prefix.length) : defaultModel
  }
  const models = provider?.models && typeof provider.models === 'object'
    ? Object.keys(provider.models)
    : []
  return models[0] || ''
}

function buildConnectionSignature(input: {
  providerId: string | null
  modelId: string
  credentials: Record<string, string>
  runtimeToolingBridge: ReturnType<typeof normalizeRuntimeToolingBridgeConsent>
}) {
  const credentials = Object.fromEntries(
    Object.entries(input.credentials).sort(([left], [right]) => left.localeCompare(right)),
  )
  return JSON.stringify({
    providerId: input.providerId,
    modelId: input.modelId.trim(),
    credentials,
    runtimeToolingBridge: normalizeRuntimeToolingBridgeConsent(input.runtimeToolingBridge),
  })
}

function docsLabel(path: string) {
  return path.replace(/^docs\//, '').replace(/\.md$/, '').replace(/-/g, ' ')
}

function docsHref(path: string) {
  if (/^https?:\/\//i.test(path)) return path
  return `${getDocsBaseUrl()}${path.replace(/^\/+/, '')}`
}

function runtimeProgressLabel(status: RuntimeLoadingStatus | null, fallback: string | null) {
  if (status?.phase === 'starting') return t('setup.progressStarting', 'Starting the model service...')
  if (status?.phase === 'config') return t('setup.progressConfig', 'Applying setup choices...')
  if (status?.phase === 'managed-server') return t('setup.progressManagedServer', 'Preparing the local model service...')
  if (status?.phase === 'connecting-events') return t('setup.progressEvents', 'Connecting status updates...')
  if (status?.phase === 'mcp') return t('setup.progressTools', 'Preparing coworker tools...')
  if (status?.phase === 'ready') return t('setup.progressReady', 'Model service is ready.')
  if (status?.phase === 'error') return t('setup.progressError', 'The model service could not start.')
  return fallback || t('setup.connectionIdle', 'Waiting for a connection test.')
}

function runtimeStatusToLoadingStatus(
  status: RuntimeStatus,
  message: string,
): RuntimeLoadingStatus {
  return {
    phase: status.ready ? 'ready' : 'error',
    message,
    ready: status.ready,
    error: status.ready ? null : status.error || message,
    updatedAt: status.updatedAt || new Date().toISOString(),
  }
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
  const [runtimeToolingBridge, setRuntimeToolingBridge] = useState(
    createDisabledRuntimeToolingBridgeConsent,
  )
  const [nativeProviderConnected, setNativeProviderConnected] = useState<Record<string, boolean>>({})
  const [selectedIntentId, setSelectedIntentId] = useState<SetupIntentId>('desktop-local')
  const [loadedCredentialProviders, setLoadedCredentialProviders] = useState<Set<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [runtimeProgress, setRuntimeProgress] = useState<RuntimeLoadingStatus | null>(null)
  const [connectionTest, setConnectionTest] = useState<ConnectionTestState>({
    status: 'idle',
    signature: null,
    message: null,
  })
  const [error, setError] = useState<string | null>(null)
  const [pendingProviderSwitch, setPendingProviderSwitch] = useState<string | null>(null)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
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
    return window.coworkApi.on.runtimeLoadingStatus((status) => {
      setRuntimeProgress(status)
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    window.coworkApi.settings.get().then(async (settings) => {
      const initialProviderId = providers.some((provider) => provider.id === settings.selectedProviderId)
        ? settings.selectedProviderId
        : settings.effectiveProviderId || defaultProviderId
      const initialProvider = providers.find((provider) => provider.id === initialProviderId) || null
      const savedEffectiveModel = settings.effectiveProviderId === initialProviderId ? settings.effectiveModel : null
      const initialModelId = initialProvider?.models.some((model) => model.id === settings.selectedModelId)
        ? settings.selectedModelId || ''
        : savedEffectiveModel
          || initialProvider?.defaultModel
          || (initialProviderId === defaultProviderId ? defaultModelId : '')
          || initialProvider?.models[0]?.id
          || ''
      const initialCredentials = initialProviderId
        ? await window.coworkApi.settings.getProviderCredentials(initialProviderId, {
            workspaceId: LOCAL_WORKSPACE_ID,
            purpose: 'credential_editor',
          })
        : {}
      if (cancelled) return
      if (!providerSelectionEdited.current) {
        setProviderId(initialProviderId)
        setModelId(initialModelId)
      }
      setRuntimeToolingBridge(normalizeRuntimeToolingBridgeConsent(settings.runtimeToolingBridge))
      if (initialProviderId) {
        mergeLoadedProviderCredentials(initialProviderId, initialCredentials)
        setLoadedCredentialProviders((current) => new Set(current).add(initialProviderId))
      }
    }).catch((err) => {
      if (cancelled) return
      addGlobalError(t('setup.loadFailed', 'Could not load setup settings. Please try again.'))
      reportSetupLoadError(err, 'Failed to load setup settings')
    })
    return () => { cancelled = true }
  }, [addGlobalError, defaultModelId, defaultProviderId, providers])

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === providerId) || null,
    [providers, providerId],
  )
  const nativeProviderConnectedOverride = providerId ? nativeProviderConnected[providerId] : undefined
  const selectedProviderConnected = nativeProviderConnectedOverride !== undefined
    ? nativeProviderConnectedOverride
    : selectedProvider?.connected === true
  const selectedIntent = useMemo(
    () => SETUP_INTENTS.find((intent) => intent.id === selectedIntentId) ?? localIntent,
    [selectedIntentId],
  )

  useEffect(() => {
    if (!selectedProvider) return
    if (!modelId) {
      setModelId(
        selectedProvider.defaultModel
        || selectedProvider.models[0]?.id
        || (selectedProvider.id === defaultProviderId ? defaultModelId : '')
        || '',
      )
    }
  }, [selectedProvider, modelId, defaultModelId, defaultProviderId])

  useEffect(() => {
    if (!providerId || loadedCredentialProviders.has(providerId)) return
    let cancelled = false
    window.coworkApi.settings.getProviderCredentials(providerId, {
      workspaceId: LOCAL_WORKSPACE_ID,
      purpose: 'credential_editor',
    }).then((credentials) => {
      if (cancelled) return
      mergeLoadedProviderCredentials(providerId, credentials)
      setLoadedCredentialProviders((current) => new Set(current).add(providerId))
    }).catch((err) => {
      if (cancelled) return
      addGlobalError(t('setup.credentialsLoadFailed', 'Could not load provider credentials. Please try again.'))
      reportSetupLoadError(err, `Failed to load provider credentials for ${providerId}`)
    })
    return () => { cancelled = true }
  }, [addGlobalError, loadedCredentialProviders, providerId])

  const selectedCredentials = useMemo(
    () => (providerId ? (providerCredentials[providerId] || {}) : {}),
    [providerCredentials, providerId],
  )
  const requiredCredentials = selectedProvider?.credentials.filter((credential) => credential.required !== false) || []
  const hasRequiredCredentials = requiredCredentials.every((credential) => (selectedCredentials[credential.key] || '').trim())
  const configuredCredential = selectedProvider?.credentials.find((credential) => {
    const value = (selectedCredentials[credential.key] || '').trim()
    return value && (!isCredentialMask(value) || credential.secret !== false)
  })
  const currentConnectionSignature = useMemo(() => buildConnectionSignature({
    providerId,
    modelId,
    credentials: selectedCredentials,
    runtimeToolingBridge,
  }), [modelId, providerId, runtimeToolingBridge, selectedCredentials])
  const connectionIsCurrent = connectionTest.status === 'success'
    && connectionTest.signature === currentConnectionSignature
  const connectionNeedsRetest = connectionTest.status === 'success' && !connectionIsCurrent
  const providerAccessReady = Boolean(
    providerId
    && selectedProvider
    && (selectedProviderConnected
      || (hasRequiredCredentials && Boolean(configuredCredential))),
  )
  const modelSelectionReady = providerAccessReady && Boolean(modelId.trim())
  const hasCompleteSelection = modelSelectionReady
  const catalogLoading = providers.length === 0
  const missingCredential = requiredCredentials.find(
    (credential) => !(selectedCredentials[credential.key] || '').trim(),
  )
  const providerAccessMethodMissing = Boolean(
    selectedProvider
    && !selectedProviderConnected
    && !configuredCredential,
  )
  const validationDisabledReason = catalogLoading
    ? t('setup.catalogLoadingDisabled', 'Wait for the model catalog to load.')
    : !providerId
      ? t('setup.providerMissing', 'Choose a provider before testing the connection.')
      : missingCredential
        ? t('setup.credentialMissing', 'Enter {{credential}} before testing the connection.', {
            credential: missingCredential.label,
          })
        : providerAccessMethodMissing
          ? selectedProvider?.credentials[0]
            ? t('setup.providerSignInOrCredentialMissing', 'Sign in to {{provider}} or enter {{credential}} before testing the connection.', {
                provider: selectedProvider.name,
                credential: selectedProvider.credentials[0].label,
              })
            : t('setup.providerSignInMissing', 'Sign in to {{provider}} before testing the connection.', {
                provider: selectedProvider?.name || providerId,
              })
        : !modelId.trim()
          ? t('setup.modelMissing', 'Choose a model before testing the connection.')
          : null
  const continueDisabledReason = validationDisabledReason
    || (!connectionIsCurrent ? t('setup.validationMissing', 'Test the connection before continuing.') : null)
  const canContinue = hasCompleteSelection && connectionIsCurrent
  const setupProgress = connectionIsCurrent ? 3 : modelSelectionReady ? 2 : providerAccessReady ? 1 : 0
  const progressPercent = connectionTest.status === 'testing'
    ? phaseProgress[runtimeProgress?.phase || 'starting']
    : connectionIsCurrent
      ? 100
      : Math.max(12, setupProgress * 28)
  const visibleRuntimeProgress = connectionTest.status === 'testing' || connectionIsCurrent
    ? runtimeProgress
    : null
  const visibleConnectionMessage = connectionNeedsRetest
    ? t('setup.connectionRetestProgress', 'Connection settings changed. Test again to verify them.')
    : connectionTest.message

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

  const providerHasUnsavedCredentials = (id: string | null) => {
    if (!id) return false
    const dirtyKeys = dirtyProviderCredentialKeys.current[id]
    if (!dirtyKeys || dirtyKeys.size === 0) return false
    const entered = providerCredentials[id] || {}
    return Array.from(dirtyKeys).some((key) => (entered[key] || '').trim().length > 0)
  }

  const applyProviderSwitch = (id: string) => {
    const provider = providers.find((entry) => entry.id === id)
    providerSelectionEdited.current = true
    setProviderId(id)
    setModelId(provider?.defaultModel || provider?.models[0]?.id || '')
  }

  const requestProviderSwitch = (id: string) => {
    if (id === providerId) return
    if (providerHasUnsavedCredentials(providerId)) {
      setPendingProviderSwitch(id)
      return
    }
    applyProviderSwitch(id)
  }

  const saveSetupSelection = async (
    modelOverride?: string,
    options: { allowMissingModel?: boolean; allowMissingCredentials?: boolean } = {},
  ) => {
    if (!providerId) return null
    const nextModelId = (modelOverride || modelId).trim()
    if (
      (!nextModelId && !options.allowMissingModel)
      || (!hasRequiredCredentials && !options.allowMissingCredentials)
    ) return null
    return window.coworkApi.settings.set({
      selectedProviderId: providerId,
      selectedModelId: nextModelId,
      runtimeToolingBridge,
      providerCredentials: {
        [providerId]: selectedCredentials,
      },
    })
  }

  const applySavedRuntimeSelection = async (setupComplete: boolean) => {
    // A complete proof means settings:set has already applied any
    // runtime-sensitive change before returning. An incomplete proof needs
    // one explicit restart so the subsequent live connection check targets
    // the newly saved selection.
    return setupComplete
      ? window.coworkApi.runtime.status()
      : window.coworkApi.runtime.restart({ purpose: 'setup_connection_validation' })
  }

  const prepareProviderAuthorization = async () => {
    setSaving(true)
    setError(null)
    try {
      const saved = await saveSetupSelection(undefined, {
        allowMissingModel: true,
        allowMissingCredentials: true,
      })
      if (!saved) return false
      const status = await applySavedRuntimeSelection(saved.setupComplete)
      if (!status.ready) {
        setError(status.error || t('setup.runtimeFailed', 'The model service could not start with these settings. Double-check your key and try again.'))
        return false
      }
      return true
    } catch (err: unknown) {
      setError(setupActionErrorMessage(err, t('setup.saveFailed', 'Failed to save settings')))
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleTestConnection = async () => {
    if (!hasCompleteSelection) {
      setError(t('setup.connectionMissingFields', 'Choose a provider, enter the required key, and choose a model before testing.'))
      return
    }
    if (!providerId) return
    setSaving(true)
    setError(null)
    setRuntimeProgress({
      phase: 'starting',
      message: t('setup.connectionSaving', 'Saving setup choices...'),
      ready: false,
      error: null,
      updatedAt: new Date().toISOString(),
    })
    setConnectionTest({
      status: 'testing',
      signature: null,
      message: t('setup.connectionTesting', 'Testing the model connection...'),
    })
    try {
      const saved = await saveSetupSelection()
      if (!saved) return
      const status = await applySavedRuntimeSelection(saved.setupComplete)
      if (!status.ready) {
        const message = status.error || t('setup.runtimeFailed', 'The model service could not start with these settings. Double-check your key and try again.')
        setRuntimeProgress(runtimeStatusToLoadingStatus(status, message))
        setError(message)
        setConnectionTest({ status: 'error', signature: null, message })
        return
      }
      setRuntimeProgress(runtimeStatusToLoadingStatus(
        status,
        t('setup.progressReady', 'Model service is ready.'),
      ))
      await window.coworkApi.provider.testConnection(providerId, modelId.trim())
      const message = t('setup.connectionReady', 'Connection tested. You can start using {{brandName}}.', { brandName })
      setConnectionTest({
        status: 'success',
        signature: currentConnectionSignature,
        message,
      })
    } catch (err: unknown) {
      const message = setupActionErrorMessage(err, t('setup.saveFailed', 'Failed to save settings'))
      setError(message)
      setConnectionTest({ status: 'error', signature: null, message })
    } finally {
      setSaving(false)
    }
  }

  const handleContinue = async () => {
    if (!canContinue) {
      setError(continueDisabledReason || t('setup.connectionMissingFields', 'Complete setup before continuing.'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await saveSetupSelection()
      if (!saved) return
      if (!saved.setupComplete) {
        const message = t(
          'setup.connectionValidationExpired',
          'Connection validation is no longer current. Test the connection again.',
        )
        setError(message)
        setConnectionTest({ status: 'error', signature: null, message })
        return
      }
      // The successful connection test verified this exact provider, model,
      // credential, and runtime-consent signature. This final save is
      // idempotent and therefore cannot trigger a redundant runtime restart.
      onComplete()
    } catch (err: unknown) {
      setError(setupActionErrorMessage(err, t('setup.saveFailed', 'Failed to save settings')))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-screen w-screen overflow-y-auto bg-base">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
        <header className="flex flex-col items-center gap-2 text-center">
          <BrandMark size="sm" />
          <h1 className="text-lg font-semibold text-text">
            {email
              ? t('setup.welcomeUser', 'Welcome, {{name}}', { name: email.split('@')[0]! })
              : t('setup.welcomeGeneric', 'Welcome to {{brandName}}', { brandName })}
          </h1>
          <p className="max-w-xl text-sm text-text-muted">
            {t('setup.description', 'Connect an AI model, choose your default model, then start your first prompt.')}
          </p>
        </header>

        <section aria-label={t('setup.progress', 'Setup progress')} className="rounded-2xl border border-border-subtle bg-elevated p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: t('setup.stepConnect', 'Connect a provider'), done: providerAccessReady || connectionIsCurrent },
              { label: t('setup.stepChoose', 'Choose model'), done: modelSelectionReady || connectionIsCurrent },
              { label: t('setup.stepDone', 'Start chatting'), done: connectionIsCurrent },
            ].map((step, index) => (
              <div
                key={step.label}
                aria-label={t('setup.stepStatus', '{{step}}: {{status}}', {
                  step: step.label,
                  status: step.done
                    ? t('setup.stepComplete', 'Complete')
                    : t('setup.stepNotComplete', 'Not complete'),
                })}
                className="flex items-center gap-2 text-sm text-text-secondary"
              >
                <span className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold ${step.done ? 'border-accent bg-accent text-accent-foreground' : 'border-border-subtle text-text-muted'}`}>
                  {index + 1}
                </span>
                <span className={step.done ? 'text-text' : undefined}>{step.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface">
            <div
              className={`h-full rounded-full bg-accent transition-[width] ${connectionTest.status === 'testing' ? 'ui-progress-shimmer' : ''}`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-text-muted">
            {runtimeProgressLabel(visibleRuntimeProgress, visibleConnectionMessage)}
          </p>
        </section>

        <section className="rounded-2xl border border-border-subtle bg-elevated p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-text">{t('setup.localTitle', 'Running on this Mac')}</h2>
                <Badge tone={connectionIsCurrent ? 'success' : 'muted'}>
                  {connectionIsCurrent
                    ? t('setup.localReady', 'Ready')
                    : t('setup.localNotReady', 'Not ready')}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-text-muted">
                {t('setup.localDescription', 'Your projects and model credentials stay on this computer unless you choose a team or server option.')}
              </p>
            </div>
            <a
              href={docsHref(localIntent.primaryDocs)}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-accent hover:underline"
            >
              {t('setup.learnMore', 'Learn more')}
            </a>
          </div>
        </section>

        <section className="flex flex-col gap-3" aria-label={t('setup.providerSection', 'Model provider')}>
          <div>
            <h2 className="text-base font-semibold text-text">{t('setup.providerTitle', 'Model provider')}</h2>
            <p className="text-sm text-text-muted">
              {t('setup.providerDescription', 'Choose the account that will power your coworkers.')}
            </p>
          </div>
          {catalogLoading ? (
            <div
              role="status"
              aria-label={t('setup.catalogLoadingLabel', 'Loading model catalog')}
              aria-live="polite"
              className="rounded-xl border border-border-subtle bg-surface px-3 py-3 text-sm text-text-muted"
            >
              {t('setup.catalogLoading', 'Loading model catalog...')}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {providers.map((provider) => {
                const active = providerId === provider.id
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => requestProviderSwitch(provider.id)}
                    className={`rounded-2xl border px-4 py-3 text-start transition-colors ${active ? 'border-accent bg-accent/10' : 'border-border-subtle bg-elevated hover:bg-surface-hover'}`}
                  >
                    <div className={`text-sm font-semibold ${active ? 'text-accent' : 'text-text'}`}>{provider.name}</div>
                    <div className="mt-1 text-xs text-text-muted">{t('setup.providerCardHint', 'Use this provider for new chats.')}</div>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {selectedProvider ? (
          <section className="flex flex-col gap-4 rounded-2xl border border-border-subtle bg-elevated p-4" aria-label={t('setup.connectionSection', 'Connection details')}>
            <div>
              <h2 className="text-base font-semibold text-text">{t('settings.models.authentication', 'Authentication')}</h2>
              <p className="text-sm text-text-muted">
                {t('setup.authenticationDescription', 'Use a browser sign-in if available, or enter the required API key.')}
              </p>
            </div>
            <Suspense
              fallback={(
                <div className="rounded-lg border border-border-subtle bg-base px-3 py-2 text-sm text-text-muted" role="status" aria-live="polite">
                  {t('providerAuth.loading', 'Loading sign-in options...')}
                </div>
              )}
            >
              <ProviderAuthControls
                providerId={providerId}
                providerName={selectedProvider.name}
                connected={selectedProviderConnected}
                disabled={!providerId || saving}
                copyMode="setup"
                onBeforeAuthorize={prepareProviderAuthorization}
                onAuthUpdated={async (connected) => {
                  setNativeProviderConnected((current) => ({
                    ...current,
                    [selectedProvider.id]: connected,
                  }))
                  setRuntimeProgress(null)
                  setConnectionTest({
                    status: 'idle',
                    signature: null,
                    message: connected
                      ? t('setup.providerAuthChanged', 'Provider sign-in changed. Test the connection again.')
                      : t('setup.providerAuthRemoved', 'Provider sign-in was removed. Sign in and test the connection again.'),
                  })
                  setError(null)
                  if (!connected) return
                  const authModelId = selectedProvider.defaultModel
                    || await resolveRuntimeProviderDefaultModel(providerId)
                    || modelId
                  setModelId(authModelId)
                }}
              />
            </Suspense>
            {selectedProvider.credentials.length > 0 ? (
              <div className="flex flex-col gap-3">
                {selectedProvider.credentials.map((credential) => {
                  const credentialIsSecret = credentialFieldIsSecret(credential)
                  return (
                    <label key={credential.key} className="flex flex-col gap-1.5">
                      <span className="text-sm font-medium text-text-secondary">{credential.label}</span>
                      <Input
                        type={credentialIsSecret ? 'password' : 'text'}
                        value={selectedCredentials[credential.key] || ''}
                        onFocus={() => {
                          if (credentialIsSecret && isCredentialMask(selectedCredentials[credential.key])) {
                            updateCredential(credential.key, '')
                          }
                        }}
                        onChange={(event) => updateCredential(credential.key, event.target.value)}
                        placeholder={credential.placeholder}
                      />
                      <span className="text-xs text-text-muted">{credential.description}</span>
                    </label>
                  )
                })}
                <a
                  href={docsHref(localIntent.primaryDocs)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-accent hover:underline"
                >
                  {t('setup.keyHelp', 'Where do I get a key?')}
                </a>
              </div>
            ) : null}
          </section>
        ) : null}

        {selectedProvider ? (
          <section className="flex flex-col gap-3 rounded-2xl border border-border-subtle bg-elevated p-4" aria-label={t('setup.model', 'Model')}>
            <div>
              <h2 className="text-base font-semibold text-text">{t('setup.model', 'Model')}</h2>
              <p className="text-sm text-text-muted">{t('setup.modelDescription', 'Pick the model coworkers will use by default.')}</p>
            </div>
            {selectedProvider.models.length > 0 ? (
              <SetupModelCatalog
                provider={selectedProvider}
                selectedModelId={modelId}
                onSelect={setModelId}
              />
            ) : (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text-secondary">{t('setup.modelIdLabel', 'Model ID')}</span>
                <Input
                  type="text"
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  placeholder={t('setup.modelIdPlaceholder', 'Model ID')}
                />
                <span className="text-xs text-text-muted">
                  {t('setup.liveModelsHint', 'This provider fills its model list after sign-in.')}
                </span>
              </label>
            )}
          </section>
        ) : null}

        <RuntimeToolingBridgeConsentPanel
          id="setup-runtime-tooling-bridge"
          consent={runtimeToolingBridge}
          onChange={setRuntimeToolingBridge}
        />

        <section className="rounded-2xl border border-border-subtle bg-elevated p-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setAdvancedOpen((current) => !current)}
            className="flex w-full items-center justify-between gap-3 text-start"
            aria-expanded={advancedOpen}
          >
            <span>
              <span className="block text-sm font-semibold text-text">
                {t('setup.advancedTitle', 'Set up a team or server deployment')}
              </span>
              <span className="mt-1 block text-xs text-text-muted">
                {t('setup.advancedDescription', 'Optional paths for shared work, remote access, or stricter local isolation.')}
              </span>
            </span>
            <span className="text-sm text-accent">{advancedOpen ? t('common.hide', 'Hide') : t('common.show', 'Show')}</span>
          </Button>

          {advancedOpen ? (
            <div className="mt-4 flex flex-col gap-4">
              <div className="grid gap-2 sm:grid-cols-2">
                {advancedIntents.map((intent) => {
                  const active = selectedIntentId === intent.id
                  return (
                    <button
                      key={intent.id}
                      type="button"
                      onClick={() => setSelectedIntentId(intent.id)}
                      className={`min-h-24 rounded-xl border px-3 py-3 text-start transition-colors ${active ? 'border-accent bg-accent/10' : 'border-border-subtle hover:bg-surface-hover'}`}
                    >
                      <div className="text-sm font-semibold text-text">{intent.label}</div>
                      <div className="mt-1 line-clamp-3 text-xs leading-relaxed text-text-muted">{intent.summary}</div>
                    </button>
                  )
                })}
              </div>
              {selectedIntent.id !== 'desktop-local' ? (
                <div className="rounded-xl border border-border-subtle bg-base px-3 py-2 text-xs text-text-secondary">
                  <div className="font-medium text-text">{selectedIntent.topologyProfile}</div>
                  <div className="mt-1 text-text-muted">{selectedIntent.nextActions[0]}</div>
                  {selectedIntent.primaryCommand ? (
                    <div className="mt-2 rounded border border-border-subtle px-2 py-1 font-mono text-xs text-text-muted">
                      {selectedIntent.primaryCommand}
                    </div>
                  ) : null}
                  <a
                    href={docsHref(selectedIntent.primaryDocs)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex text-accent hover:underline"
                  >
                    {t('setup.readDocs', 'Read {{name}} docs', { name: docsLabel(selectedIntent.primaryDocs) })}
                  </a>
                </div>
              ) : null}

            </div>
          ) : null}
        </section>

        {connectionNeedsRetest ? (
          <div role="status" className="rounded-xl border border-amber/30 bg-amber/10 px-3 py-2 text-sm text-amber">
            {t('setup.connectionStale', 'The provider, credentials, model, or connection permissions changed. Test the connection again before continuing.')}
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="rounded-xl border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
            <div>{error}</div>
            <a href={docsHref(localIntent.primaryDocs)} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-red underline">
              {t('setup.errorDocs', 'Open setup help')}
            </a>
          </div>
        ) : null}

        <footer className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="secondary"
            fullWidth
            onClick={() => void handleTestConnection()}
            loading={connectionTest.status === 'testing'}
            disabled={!hasCompleteSelection || saving}
            disabledReason={!hasCompleteSelection ? validationDisabledReason : null}
          >
            {connectionTest.status === 'testing'
              ? t('setup.testingConnection', 'Testing connection...')
              : t('setup.testConnection', 'Test connection')}
          </Button>
          <Button
            variant="primary"
            fullWidth
            onClick={() => void handleContinue()}
            loading={saving && connectionTest.status !== 'testing'}
            disabled={!canContinue || saving}
            disabledReason={!canContinue ? continueDisabledReason : null}
          >
            {t('setup.continue', 'Get Started')}
          </Button>
        </footer>

        {connectionTest.status === 'success' && connectionIsCurrent ? (
          <div role="status" className="text-center text-sm text-text-muted">
            {connectionTest.message}
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={pendingProviderSwitch !== null}
        title={t('setup.switchProviderTitle', 'Discard entered credentials?')}
        body={t(
          'setup.switchProviderBody',
          'You have unsaved credentials for {{provider}}. Switching providers keeps them out of this setup. Switch anyway?',
          { provider: selectedProvider?.name || t('setup.switchProviderFallback', 'this provider') },
        )}
        confirmLabel={t('setup.switchProviderConfirm', 'Switch provider')}
        cancelLabel={t('common.cancel', 'Cancel')}
        onConfirm={() => {
          if (pendingProviderSwitch) applyProviderSwitch(pendingProviderSwitch)
          setPendingProviderSwitch(null)
        }}
        onCancel={() => setPendingProviderSwitch(null)}
      />
    </div>
  )
}
