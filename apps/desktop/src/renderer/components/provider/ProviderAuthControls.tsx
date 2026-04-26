import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProviderAuthAuthorization, ProviderAuthMethod, ProviderAuthPrompt } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'

function suggestedAuthLabel(providerId: string | null | undefined, providerName?: string) {
  if (providerId === 'openai') return 'ChatGPT Plus/Pro'
  return providerName || t('providerAuth.openCodeLogin', 'OpenCode login')
}

function noBrowserMethodMessage(providerId: string | null | undefined, providerName?: string) {
  return t('providerAuth.noBrowserMethod', 'OpenCode does not currently expose browser login for {{provider}} in this runtime. Use the API key field, or update OpenCode when this provider adds subscription login support.', {
    provider: suggestedAuthLabel(providerId, providerName),
  })
}

function promptIsVisible(prompt: ProviderAuthPrompt, inputs: Record<string, string>) {
  if (!prompt.when) return true
  const current = inputs[prompt.when.key] || ''
  return prompt.when.op === 'eq'
    ? current === prompt.when.value
    : current !== prompt.when.value
}

interface Props {
  providerId: string | null
  providerName?: string
  connected?: boolean
  disabled?: boolean
  onBeforeAuthorize?: () => Promise<boolean>
  onAuthUpdated?: () => void | Promise<void>
}

export function ProviderAuthControls({
  providerId,
  providerName,
  connected,
  disabled,
  onBeforeAuthorize,
  onAuthUpdated,
}: Props) {
  const [methods, setMethods] = useState<ProviderAuthMethod[]>([])
  const [loading, setLoading] = useState(false)
  const [authorizing, setAuthorizing] = useState<number | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [pending, setPending] = useState<{ method: number; authorization: ProviderAuthAuthorization } | null>(null)
  const [pendingBrowserLogin, setPendingBrowserLogin] = useState(false)
  const [code, setCode] = useState('')
  const [methodInputs, setMethodInputs] = useState<Record<number, Record<string, string>>>({})

  const loadMethods = useCallback(async () => {
    if (!providerId) return []
    setLoading(true)
    try {
      const all = await window.coworkApi.provider.authMethods()
      const next = all[providerId] || []
      setMethods(next)
      return next
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
      return []
    } finally {
      setLoading(false)
    }
  }, [providerId])

  useEffect(() => {
    setMethods([])
    setStatus(null)
    setPending(null)
    setPendingBrowserLogin(false)
    setCode('')
    setMethodInputs({})
    void loadMethods()
  }, [loadMethods])

  const oauthMethods = useMemo(
    () => methods
      .map((method, index) => ({ method, index }))
      .filter((entry) => entry.method.type === 'oauth'),
    [methods],
  )
  const shouldRender = Boolean(providerId && (oauthMethods.length > 0 || loading || connected !== undefined))
  if (!shouldRender) return null

  const setPromptInput = (method: number, key: string, value: string) => {
    setMethodInputs((current) => ({
      ...current,
      [method]: {
        ...(current[method] || {}),
        [key]: value,
      },
    }))
  }

  const startAuthorize = async (methodIndex?: number) => {
    if (!providerId) return
    setAuthorizing(methodIndex ?? -1)
    setStatus(null)
    setPending(null)
    setPendingBrowserLogin(false)
    try {
      if (onBeforeAuthorize) {
        const ok = await onBeforeAuthorize()
        if (!ok) return
      }

      const latestMethods = methods.length > 0 ? methods : await loadMethods()
      const selectedIndex = methodIndex ?? latestMethods.findIndex((method) => method.type === 'oauth')
      const selected = selectedIndex >= 0 ? latestMethods[selectedIndex] : null
      if (!selected || selected.type !== 'oauth') {
        setStatus(t('providerAuth.noOauthMethod', 'OpenCode did not expose a subscription login method for this provider. Use the API key field or update the bundled OpenCode runtime.'))
        return
      }

      const authorization = await window.coworkApi.provider.authorize(
        providerId,
        selectedIndex,
        methodInputs[selectedIndex] || {},
      )
      if (!authorization) {
        setStatus(t('providerAuth.noAuthorization', 'OpenCode did not return a login URL. Its local callback server may already be running or blocked; close any stale OpenCode login flow and try again.'))
        return
      }
      if (authorization.method === 'code') {
        setPending({ method: selectedIndex, authorization })
        setStatus(authorization.instructions || t('providerAuth.enterCode', 'Complete the browser login, then paste the authorization code here.'))
      } else {
        setPendingBrowserLogin(true)
        setStatus(t('providerAuth.browserOpened', 'Browser login opened. Complete the flow there, then return here and confirm so Open Cowork can verify the new login.'))
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setAuthorizing(null)
    }
  }

  const completeCodeFlow = async () => {
    if (!providerId || !pending) return
    setAuthorizing(pending.method)
    setStatus(null)
    try {
      const ok = await window.coworkApi.provider.callback(providerId, pending.method, code.trim())
      setStatus(ok
        ? t('providerAuth.connected', 'Provider login completed.')
        : t('providerAuth.callbackFailed', 'Provider login did not complete. Try the login flow again.'))
      if (ok) {
        if (!await verifyProviderConnected()) {
          setStatus(t('providerAuth.notVerified', 'OpenCode still does not report this provider as signed in. Finish the browser login, then try confirming again.'))
          return
        }
        setPending(null)
        setCode('')
        await onAuthUpdated?.()
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setAuthorizing(null)
    }
  }

  const verifyProviderConnected = async () => {
    if (!providerId) return false
    const checkCurrentRuntime = async (attempts: number) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const providers = await window.coworkApi.provider.list()
        if (providers.some((provider) => (
          (provider.id === providerId || provider.name === providerId)
          && provider.connected === true
        ))) {
          return true
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      return false
    }

    setStatus(t('providerAuth.verifying', 'Checking provider login status...'))
    if (await checkCurrentRuntime(5)) return true

    setStatus(t('providerAuth.reloadingRuntime', 'Reloading OpenCode to pick up the provider login...'))
    const runtimeStatus = await window.coworkApi.runtime.restart()
    if (!runtimeStatus.ready) return false
    return checkCurrentRuntime(5)
  }

  const finishBrowserLogin = async () => {
    setAuthorizing(-1)
    setStatus(null)
    try {
      if (!await verifyProviderConnected()) {
        setStatus(t('providerAuth.notVerified', 'OpenCode still does not report this provider as signed in. Finish the browser login, then try confirming again.'))
        return
      }
      await onAuthUpdated?.()
      setPendingBrowserLogin(false)
      setStatus(t('providerAuth.connected', 'Provider login completed.'))
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setAuthorizing(null)
    }
  }

  const entries = oauthMethods

  return (
    <div className="flex flex-col gap-3">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">
        {t('providerAuth.header', 'OpenCode login')}
      </span>
      <div className="rounded-2xl border border-border-subtle p-4 flex flex-col gap-3">
        <div className="text-[11px] text-text-muted leading-relaxed">
          {t('providerAuth.description', 'Use OpenCode-native provider auth for subscriptions/OAuth, or keep using the API key field above.')}
        </div>
        {connected === false ? (
          <div className="rounded-xl border border-border-subtle px-3 py-2 text-[11px] leading-relaxed" style={{ background: 'var(--color-surface)' }}>
            {t('providerAuth.notConnected', 'OpenCode does not currently report this provider as signed in. Sign in below or enter an API key above, then save before chatting.')}
          </div>
        ) : null}
        {connected === true ? (
          <div className="rounded-xl border border-border-subtle px-3 py-2 text-[11px] leading-relaxed" style={{ color: 'var(--color-green)', background: 'var(--color-surface)' }}>
            {t('providerAuth.connectedStatus', 'OpenCode reports this provider is signed in.')}
          </div>
        ) : null}
        {!loading && entries.length === 0 ? (
          <div className="rounded-xl border border-border-subtle px-3 py-2 text-[11px] leading-relaxed" style={{ background: 'var(--color-surface)' }}>
            {noBrowserMethodMessage(providerId, providerName)}
          </div>
        ) : null}
        {entries.map(({ method, index }) => {
          const inputs = methodInputs[index] || {}
          const prompts = (method.prompts || []).filter((prompt) => promptIsVisible(prompt, inputs))
          return (
            <div key={`${method.label}-${index}`} className="flex flex-col gap-2">
              {prompts.map((prompt) => (
                <label key={prompt.key} className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-text-muted font-medium">{prompt.message}</span>
                  {prompt.type === 'select' ? (
                    <select
                      value={inputs[prompt.key] || ''}
                      onChange={(event) => setPromptInput(index, prompt.key, event.target.value)}
                      className="w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text outline-none focus:border-accent/40 transition-colors"
                    >
                      <option value="">{t('common.select', 'Select')}</option>
                      {prompt.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.hint ? `${option.label} - ${option.hint}` : option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={inputs[prompt.key] || ''}
                      onChange={(event) => setPromptInput(index, prompt.key, event.target.value)}
                      placeholder={prompt.placeholder}
                      className="w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors"
                    />
                  )}
                </label>
              ))}
              <button
                type="button"
                onClick={() => startAuthorize(index >= 0 ? index : undefined)}
                disabled={disabled || loading || authorizing !== null}
                className="px-3 py-2 rounded-xl text-[12px] font-semibold cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-wait"
                style={{
                  background: 'var(--color-accent)',
                  color: 'var(--color-accent-foreground)',
                }}
              >
                {authorizing === index || (index < 0 && authorizing === -1)
                  ? t('providerAuth.opening', 'Opening...')
                  : t('providerAuth.signInWith', 'Sign in with {{label}}', { label: method.label })}
              </button>
            </div>
          )
        })}
        {pending ? (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={t('providerAuth.codePlaceholder', 'Authorization code')}
              className="w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors"
            />
            <button
              type="button"
              onClick={completeCodeFlow}
              disabled={!code.trim() || authorizing !== null}
              className="px-3 py-2 rounded-xl text-[12px] font-semibold cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-wait"
              style={{
                background: 'var(--color-surface-hover)',
                color: 'var(--color-text)',
              }}
            >
              {t('providerAuth.completeCode', 'Complete login')}
            </button>
          </div>
        ) : null}
        {pendingBrowserLogin ? (
          <button
            type="button"
            onClick={finishBrowserLogin}
            disabled={authorizing !== null}
            className="px-3 py-2 rounded-xl text-[12px] font-semibold cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-wait border border-border-subtle text-text hover:bg-surface-hover"
          >
            {authorizing === -1
              ? t('providerAuth.finishing', 'Finishing...')
              : t('providerAuth.finishedBrowserLogin', "I've finished signing in")}
          </button>
        ) : null}
        {status ? <div className="text-[11px] text-text-muted leading-relaxed">{status}</div> : null}
      </div>
    </div>
  )
}
