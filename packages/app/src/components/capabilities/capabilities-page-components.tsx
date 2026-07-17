import { useEffect, useRef, useState } from 'react'
import { credentialFieldIsVisible } from '@open-cowork/shared'
import type { CapabilityTool, RuntimeContextOptions } from '@open-cowork/shared'
import { Markdown } from '../chat/Markdown'
import { t } from '../../helpers/i18n'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { credentialFieldIsSecret } from '../provider/credential-merge'
import { Button, Card, EmptyState, Icon, Input, Select } from '@open-cowork/ui'

function describeCapabilityError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function reportCapabilityError(error: unknown, scope: string) {
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `${scope}: ${describeCapabilityError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'capabilities',
    })
  } catch {
    // Diagnostics are best-effort from a capabilities recovery path.
  }
}

export function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <Card variant="flat" padding="sm">
      <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-text-muted mb-1">{label}</div>
      <div className="text-xs text-text-secondary break-all">{value}</div>
    </Card>
  )
}

export function EmptyGrid({ message }: { message: string }) {
  return (
    <EmptyState
      icon="blocks"
      title={t('capabilities.emptyTitle', 'Nothing to show')}
      body={message}
    />
  )
}

// One row in the skill bundle's file list. Lazy-loads the file body
// on click via `settings.capabilities.skillBundleFile(...)` to avoid
// bloating initial payloads for skills with large reference files.
export function SkillBundleFileEntry({
  skillName,
  filePath,
  context,
}: {
  skillName: string
  filePath: string
  context: RuntimeContextOptions | undefined
}) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (content !== null) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.coworkApi.capabilities.skillBundleFile(skillName, filePath, context)
      setContent(result ?? '')
      if (result == null) setError('File content unavailable.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const isMarkdown = /\.(md|markdown)$/i.test(filePath)

  return (
    <Card variant="flat" style={{ padding: 0 }}>
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-2 px-3 py-3 text-start cursor-pointer"
      >
        <Icon
          name="chevron-right"
          size={16}
          className="text-text-muted shrink-0 transition-transform"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <span className="text-xs font-medium text-text flex-1 truncate">{filePath}</span>
      </button>
      {expanded ? (
        <div className="px-3 pb-3 border-t border-border-subtle pt-3">
          {loading ? (
            <div className="text-2xs text-text-muted">{t('capabilities.bundleFileLoading', 'Loading…')}</div>
          ) : error ? (
            <div className="text-2xs text-red">{error}</div>
          ) : isMarkdown ? (
            <div className="min-w-0 max-w-full overflow-x-auto">
              <Markdown
                text={content || ''}
                className="prose prose-invert max-w-none text-xs text-text-secondary leading-relaxed [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_code]:break-words [&_p]:break-words"
              />
            </div>
          ) : (
            <div className="min-w-0 max-w-full overflow-x-auto">
              <pre className="text-2xs text-text-secondary whitespace-pre-wrap break-all font-mono">{content || ''}</pre>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  )
}

type ToolCredential = NonNullable<CapabilityTool['credentials']>[number]

function credentialValueForConditions(
  credentials: ToolCredential[],
  stored: Record<string, string>,
  drafts: Record<string, string>,
) {
  return Object.fromEntries(
    credentials.map((credential) => [
      credential.key,
      drafts[credential.key] ?? stored[credential.key] ?? '',
    ]),
  )
}

// Per-MCP credential form surfaced in the Capabilities detail panel.
// Reads only this integration's stored credential values and persists
// through the shared settings path used by runtime env/header settings.
export function ToolCredentialsCard({
  integrationId,
  credentials,
  authMode,
}: {
  integrationId: string
  credentials: NonNullable<CapabilityTool['credentials']>
  authMode?: CapabilityTool['authMode']
}) {
  const [stored, setStored] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [preflightMessage, setPreflightMessage] = useState<string | null>(null)
  const [preflightTone, setPreflightTone] = useState<'success' | 'warning' | 'error' | null>(null)
  const addGlobalError = useSessionStore((state) => state.addGlobalError)

  useEffect(() => {
    let cancelled = false
    window.coworkApi.settings.getIntegrationCredentials(integrationId, {
      workspaceId: LOCAL_WORKSPACE_ID,
      purpose: 'credential_editor',
    })
      .then((current) => {
        if (cancelled) return
        setStored(current)
        setDrafts({})
        setPreflightMessage(null)
        setPreflightTone(null)
      })
      .catch((err) => {
        if (cancelled) return
        addGlobalError(t('capabilities.credentialsLoadFailed', 'Could not load stored integration credentials. Please try again.'))
        reportCapabilityError(err, `Failed to load stored integration credentials for ${integrationId}`)
      })
    return () => { cancelled = true }
  }, [addGlobalError, integrationId])

  const dirty = Object.keys(drafts).some((key) => drafts[key] !== undefined && drafts[key] !== '')

  async function runPreflight() {
    if (authMode !== 'api_token') return
    setTesting(true)
    setPreflightMessage(null)
    setPreflightTone(null)
    try {
      const result = await window.coworkApi.mcp.preflight(integrationId)
      const parts = [
        result.message,
        result.helpText,
        result.responseBody ? `Response: ${result.responseBody}` : null,
      ].filter(Boolean)
      setPreflightMessage(parts.join(' '))
      setPreflightTone(result.ok
        ? 'success'
        : result.status === 'missing_credentials' || result.status === 'not_applicable'
          ? 'warning'
          : 'error')
    } catch (error) {
      setPreflightMessage(error instanceof Error ? error.message : String(error))
      setPreflightTone('error')
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!dirty || saving || testing) return
    setSaving(true)
    setErrorMessage(null)
    setPreflightMessage(null)
    setPreflightTone(null)
    try {
      const patch: Record<string, string> = {}
      for (const credential of credentials) {
        const draft = drafts[credential.key]
        if (draft === undefined) continue
        patch[credential.key] = draft
      }
      const savedSettings = await window.coworkApi.settings.set({
        integrationCredentials: {
          [integrationId]: patch,
        },
      })
      const refreshed = await window.coworkApi.settings.getIntegrationCredentials(integrationId, {
        workspaceId: LOCAL_WORKSPACE_ID,
        purpose: 'credential_editor',
      })
      setStored(refreshed)
      setDrafts({})
      setSavedAt(Date.now())
      if (savedSettings.integrationEnabled?.[integrationId] !== false) {
        await runPreflight()
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const conditionValues = credentialValueForConditions(credentials, stored, drafts)
  const visibleCredentials = credentials.filter((credential) => (
    credentialFieldIsVisible(credential, conditionValues)
  ))

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-2xs font-[750] uppercase tracking-[0.06em] text-text-muted">
          {t('capabilities.credentials', 'Credentials')}
        </div>
        {savedAt ? (
          <span className="text-2xs text-text-muted">{t('capabilities.credentialsSaved', 'Saved')}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-3">
        {visibleCredentials.map((credential) => {
          const storedValue = stored[credential.key] ?? ''
          const hasStored = Boolean(storedValue)
          const draft = drafts[credential.key]
          const options = credential.options || []
          const isChoiceField = (credential.type === 'select' || credential.type === 'radio') && options.length > 0
          const credentialIsSecret = credentialFieldIsSecret(credential)
          const value = draft !== undefined
            ? draft
            : credentialIsSecret && !isChoiceField
              ? (hasStored ? '••••••••' : '')
              : storedValue
          const selectedOption = options.find((option) => option.value === value)
          if (isChoiceField) {
            if (credential.type === 'radio') {
              return (
                <fieldset key={credential.key} className="flex flex-col gap-1">
                  <legend className="text-2xs font-medium text-text-secondary">
                    {credential.label}{credential.required ? <span className="text-red ms-1">*</span> : null}
                  </legend>
                  <div className="flex flex-col gap-2">
                    {options.map((option) => (
                      <label
                        key={option.value}
                        className="flex items-start gap-2 rounded-lg border border-border-subtle bg-elevated px-3 py-2"
                      >
                        <input
                          type="radio"
                          name={`${integrationId}-${credential.key}`}
                          value={option.value}
                          checked={value === option.value}
                          onChange={(event) => {
                            setDrafts((current) => ({ ...current, [credential.key]: event.target.value }))
                          }}
                          className="mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-text-secondary">{option.label}</span>
                          {option.hint ? (
                            <span className="block text-2xs text-text-muted leading-relaxed">{option.hint}</span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                  {credential.description ? (
                    <span className="text-2xs text-text-muted leading-relaxed">{credential.description}</span>
                  ) : null}
                </fieldset>
              )
            }

            return (
              <div key={credential.key} className="flex flex-col gap-1">
                <span className="text-2xs font-medium text-text-secondary">
                  {credential.label}{credential.required ? <span className="text-red ms-1">*</span> : null}
                </span>
                <Select
                  label={credential.label}
                  value={value}
                  onChange={(next) => {
                    setDrafts((current) => ({ ...current, [credential.key]: next }))
                  }}
                  options={[
                    { value: '', label: credential.placeholder || t('capabilities.credentialsSelectPlaceholder', 'Select an option') },
                    ...options.map((option) => ({ value: option.value, label: option.label })),
                  ]}
                />
                {selectedOption?.hint ? (
                  <span className="text-2xs text-text-muted leading-relaxed">{selectedOption.hint}</span>
                ) : null}
                {credential.description ? (
                  <span className="text-2xs text-text-muted leading-relaxed">{credential.description}</span>
                ) : null}
              </div>
            )
          }

          return (
            <div key={credential.key} className="flex flex-col gap-1">
              <span className="text-2xs font-medium text-text-secondary">
                {credential.label}{credential.required ? <span className="text-red ms-1">*</span> : null}
              </span>
              <Input
                type={credentialIsSecret ? 'password' : 'text'}
                aria-label={credential.label}
                value={value}
                placeholder={credential.placeholder || ''}
                onFocus={(event) => {
                  if (credentialIsSecret && draft === undefined && hasStored) {
                    setDrafts((current) => ({ ...current, [credential.key]: '' }))
                    event.currentTarget.value = ''
                  }
                }}
                onChange={(event) => {
                  setDrafts((current) => ({ ...current, [credential.key]: event.target.value }))
                }}
                autoComplete="off"
                spellCheck={false}
              />
              {credential.description ? (
                <span className="text-2xs text-text-muted leading-relaxed">{credential.description}</span>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        {authMode === 'api_token' ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { void runPreflight() }}
            disabled={dirty || saving || testing}
            loading={testing}
          >
            {testing ? t('capabilities.credentialsTesting', 'Testing…') : t('capabilities.credentialsTest', 'Test')}
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={!dirty || saving || testing}
          loading={saving}
        >
          {saving ? t('capabilities.credentialsSaving', 'Saving…') : t('capabilities.credentialsSave', 'Save')}
        </Button>
      </div>
      {errorMessage ? (
        <div className="mt-3 text-2xs text-red">
          {errorMessage}
        </div>
      ) : null}
      {preflightMessage ? (
        <div
          className={`mt-3 text-2xs leading-relaxed ${
            preflightTone === 'success'
              ? 'text-green'
              : preflightTone === 'warning'
                ? 'text-amber'
                : 'text-red'
          }`}
          role={preflightTone === 'error' ? 'alert' : 'status'}
        >
          {preflightMessage}
        </div>
      ) : null}
    </Card>
  )
}

// Per-integration enable toggle. Undefined defaults to off for OAuth
// integrations and readiness-driven for API-token / no-auth integrations.
export function ToolIntegrationToggleCard({
  integrationId,
  authMode,
  enabled,
}: {
  integrationId: string
  authMode: 'none' | 'oauth' | 'api_token'
  enabled: boolean | undefined
}) {
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [localEnabled, setLocalEnabled] = useState<boolean | undefined>(enabled)
  const [hasStoredCredentials, setHasStoredCredentials] = useState(false)
  const mountedRef = useRef(true)
  const addGlobalError = useSessionStore((state) => state.addGlobalError)

  useEffect(() => {
    setLocalEnabled(enabled)
    setErrorMessage(null)
  }, [enabled, integrationId])

  useEffect(() => {
    let cancelled = false
    window.coworkApi.settings.get().then((settings) => {
      if (cancelled) return
      const entries = settings.integrationCredentials?.[integrationId] || {}
      setHasStoredCredentials(Object.values(entries).some((value) => typeof value === 'string' && value.length > 0))
    }).catch((err) => {
      if (cancelled) return
      addGlobalError(t('capabilities.credentialReadinessLoadFailed', 'Could not verify integration credential readiness. Please try again.'))
      reportCapabilityError(err, `Failed to load integration credential readiness for ${integrationId}`)
    })
    return () => { cancelled = true }
  }, [addGlobalError, integrationId])

  useEffect(() => () => { mountedRef.current = false }, [])

  const effectiveOn = localEnabled !== undefined
    ? localEnabled
    : authMode === 'oauth'
      ? false
      : authMode === 'api_token'
        ? hasStoredCredentials
        : true

  async function setEnabled(next: boolean) {
    if (pending) return
    const targetId = integrationId
    const previous = localEnabled
    setPending(true)
    setErrorMessage(null)
    setLocalEnabled(next)
    try {
      await window.coworkApi.settings.set({
        integrationEnabled: { [targetId]: next },
      })
    } catch (error) {
      if (mountedRef.current && targetId === integrationId) {
        setLocalEnabled(previous)
        setErrorMessage(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (mountedRef.current) setPending(false)
    }
  }

  const helpText = authMode === 'oauth'
    ? t(
      'capabilities.integrationOAuthHelp',
      'Turn this on to sign in with the provider. Until you do, the integration is bundled but dormant — nothing runs and no status errors are reported.',
    )
    : authMode === 'api_token'
      ? t(
        'capabilities.integrationApiTokenHelp',
        'Enabled once you save an API key below. You can force-disable to hide it entirely.',
      )
      : t(
        'capabilities.integrationNoneHelp',
        'Bundled infrastructure. Disable only if you really want to turn it off for this install.',
      )

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="text-2xs font-[750] uppercase tracking-[0.06em] text-text-muted">
            {t('capabilities.integrationStatus', 'Integration')}
          </div>
          <div className="text-xs text-text">
            {effectiveOn
              ? t('capabilities.integrationOn', 'Enabled')
              : t('capabilities.integrationOff', 'Disabled')}
          </div>
          <div className="text-2xs text-text-muted leading-relaxed">{helpText}</div>
        </div>
        <Button
          role="switch"
          aria-checked={effectiveOn}
          variant={effectiveOn ? 'secondary' : 'primary'}
          size="sm"
          disabled={pending}
          loading={pending}
          onClick={() => { void setEnabled(!effectiveOn) }}
          className="whitespace-nowrap shrink-0"
        >
          {effectiveOn
            ? t('capabilities.integrationDisableCta', 'Disable')
            : authMode === 'oauth'
              ? t('capabilities.integrationEnableOAuthCta', 'Enable & sign in')
              : t('capabilities.integrationEnableCta', 'Enable')}
        </Button>
      </div>
      {errorMessage ? (
        <div className="mt-3 text-2xs text-red" role="alert">
          {t('capabilities.integrationToggleFailed', 'Couldn’t update this integration:')} {errorMessage}
        </div>
      ) : null}
    </Card>
  )
}
