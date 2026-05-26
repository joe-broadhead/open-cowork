import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { credentialFieldIsVisible } from '@open-cowork/shared'
import type { CapabilityTool, RuntimeContextOptions } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { useSessionStore } from '../../stores/session'

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
    <div className="rounded-xl border border-border-subtle bg-elevated px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">{label}</div>
      <div className="text-[12px] text-text-secondary break-all">{value}</div>
    </div>
  )
}

export function EmptyGrid({ message }: { message: string }) {
  return (
    <div className="text-[12px] text-text-muted py-6 text-center rounded-xl border border-border-subtle border-dashed">
      {message}
    </div>
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
    <div className="rounded-xl border border-border-subtle bg-elevated">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-2 px-3 py-3 text-start cursor-pointer"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-text-muted shrink-0 transition-transform"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <polyline points="4,2 8,6 4,10" />
        </svg>
        <span className="text-[12px] font-medium text-text flex-1 truncate">{filePath}</span>
      </button>
      {expanded ? (
        <div className="px-3 pb-3 border-t border-border-subtle pt-3">
          {loading ? (
            <div className="text-[11px] text-text-muted">{t('capabilities.bundleFileLoading', 'Loading…')}</div>
          ) : error ? (
            <div className="text-[11px] text-red">{error}</div>
          ) : isMarkdown ? (
            <div className="min-w-0 max-w-full overflow-x-auto">
              <div className="prose prose-invert max-w-none text-[12px] text-text-secondary leading-relaxed [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_code]:break-words [&_p]:break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || ''}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="min-w-0 max-w-full overflow-x-auto">
              <pre className="text-[11px] text-text-secondary whitespace-pre-wrap break-all font-mono">{content || ''}</pre>
            </div>
          )}
        </div>
      ) : null}
    </div>
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
    window.coworkApi.settings.getIntegrationCredentials(integrationId)
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
      setPreflightTone(result.ok ? 'success' : result.status === 'missing_credentials' ? 'warning' : 'error')
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
      await window.coworkApi.settings.set({
        integrationCredentials: {
          [integrationId]: patch,
        },
      })
      const refreshed = await window.coworkApi.settings.getIntegrationCredentials(integrationId)
      setStored(refreshed)
      setDrafts({})
      setSavedAt(Date.now())
      await runPreflight()
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
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {t('capabilities.credentials', 'Credentials')}
        </div>
        {savedAt ? (
          <span className="text-[10px] text-text-muted">{t('capabilities.credentialsSaved', 'Saved')}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-3">
        {visibleCredentials.map((credential) => {
          const storedValue = stored[credential.key] ?? ''
          const hasStored = Boolean(storedValue)
          const draft = drafts[credential.key]
          const options = credential.options || []
          const isChoiceField = (credential.type === 'select' || credential.type === 'radio') && options.length > 0
          const value = draft !== undefined
            ? draft
            : credential.secret && !isChoiceField
              ? (hasStored ? '••••••••' : '')
              : storedValue
          const selectedOption = options.find((option) => option.value === value)
          if (isChoiceField) {
            if (credential.type === 'radio') {
              return (
                <fieldset key={credential.key} className="flex flex-col gap-1">
                  <legend className="text-[11px] font-medium text-text-secondary">
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
                          <span className="block text-[12px] font-medium text-text-secondary">{option.label}</span>
                          {option.hint ? (
                            <span className="block text-[10px] text-text-muted leading-relaxed">{option.hint}</span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                  {credential.description ? (
                    <span className="text-[10px] text-text-muted leading-relaxed">{credential.description}</span>
                  ) : null}
                </fieldset>
              )
            }

            return (
              <label key={credential.key} className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-text-secondary">
                  {credential.label}{credential.required ? <span className="text-red ms-1">*</span> : null}
                </span>
                <select
                  value={value}
                  onChange={(event) => {
                    setDrafts((current) => ({ ...current, [credential.key]: event.target.value }))
                  }}
                  className="px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text outline-none focus:border-border"
                >
                  <option value="">{credential.placeholder || t('capabilities.credentialsSelectPlaceholder', 'Select an option')}</option>
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                {selectedOption?.hint ? (
                  <span className="text-[10px] text-text-muted leading-relaxed">{selectedOption.hint}</span>
                ) : null}
                {credential.description ? (
                  <span className="text-[10px] text-text-muted leading-relaxed">{credential.description}</span>
                ) : null}
              </label>
            )
          }

          return (
            <label key={credential.key} className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-text-secondary">
                {credential.label}{credential.required ? <span className="text-red ms-1">*</span> : null}
              </span>
              <input
                type={credential.secret ? 'password' : 'text'}
                value={value}
                placeholder={credential.placeholder || ''}
                onFocus={(event) => {
                  if (credential.secret && draft === undefined && hasStored) {
                    setDrafts((current) => ({ ...current, [credential.key]: '' }))
                    event.currentTarget.value = ''
                  }
                }}
                onChange={(event) => {
                  setDrafts((current) => ({ ...current, [credential.key]: event.target.value }))
                }}
                className="px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
                autoComplete="off"
                spellCheck={false}
              />
              {credential.description ? (
                <span className="text-[10px] text-text-muted leading-relaxed">{credential.description}</span>
              ) : null}
            </label>
          )
        })}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        {authMode === 'api_token' ? (
          <button
            type="button"
            onClick={() => { void runPreflight() }}
            disabled={dirty || saving || testing}
            className="px-3 py-2 rounded-lg text-[12px] font-medium border border-border-subtle text-text-secondary hover:bg-surface-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testing ? t('capabilities.credentialsTesting', 'Testing…') : t('capabilities.credentialsTest', 'Test')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving || testing}
          className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: 'var(--color-accent)', color: 'var(--color-accent-contrast, #fff)' }}
        >
          {saving ? t('capabilities.credentialsSaving', 'Saving…') : t('capabilities.credentialsSave', 'Save')}
        </button>
      </div>
      {errorMessage ? (
        <div className="mt-3 text-[11px]" style={{ color: 'var(--color-red)' }}>
          {errorMessage}
        </div>
      ) : null}
      {preflightMessage ? (
        <div
          className="mt-3 text-[11px] leading-relaxed"
          style={{
            color: preflightTone === 'success'
              ? 'var(--color-green)'
              : preflightTone === 'warning'
                ? 'var(--color-warning)'
                : 'var(--color-red)',
          }}
          role={preflightTone === 'error' ? 'alert' : 'status'}
        >
          {preflightMessage}
        </div>
      ) : null}
    </div>
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
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            {t('capabilities.integrationStatus', 'Integration')}
          </div>
          <div className="text-[12px] text-text-primary">
            {effectiveOn
              ? t('capabilities.integrationOn', 'Enabled')
              : t('capabilities.integrationOff', 'Disabled')}
          </div>
          <div className="text-[10px] text-text-muted leading-relaxed">{helpText}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={effectiveOn}
          disabled={pending}
          onClick={() => { void setEnabled(!effectiveOn) }}
          className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          style={effectiveOn
            ? { background: 'var(--color-surface-active)', color: 'var(--color-text-secondary)' }
            : { background: 'var(--color-accent)', color: 'var(--color-accent-contrast, #fff)' }}
        >
          {effectiveOn
            ? t('capabilities.integrationDisableCta', 'Disable')
            : authMode === 'oauth'
              ? t('capabilities.integrationEnableOAuthCta', 'Enable & sign in')
              : t('capabilities.integrationEnableCta', 'Enable')}
        </button>
      </div>
      {errorMessage ? (
        <div className="mt-3 text-[11px] text-red" role="alert">
          {t('capabilities.integrationToggleFailed', 'Couldn’t update this integration:')} {errorMessage}
        </div>
      ) : null}
    </div>
  )
}
