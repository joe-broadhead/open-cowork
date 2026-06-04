import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderAuthMethod, ProviderAuthPrompt } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { writeTextToClipboard } from '../../helpers/clipboard'

type CopyMode = 'settings' | 'setup'

function suggestedAuthLabel(providerId: string | null | undefined, providerName?: string, copyMode: CopyMode = 'settings') {
  if (providerId === 'openai') return 'ChatGPT Plus/Pro'
  return providerName || (
    copyMode === 'setup'
      ? t('providerAuth.browserLogin', 'Browser login')
      : t('providerAuth.openCodeLogin', 'OpenCode login')
  )
}

function noBrowserMethodMessage(providerId: string | null | undefined, providerName?: string, copyMode: CopyMode = 'settings') {
  if (copyMode === 'setup') {
    return t('providerAuth.noBrowserMethodSetup', 'Browser sign-in is not available for {{provider}} yet. Use the API key field.', {
      provider: suggestedAuthLabel(providerId, providerName, copyMode),
    })
  }
  return t('providerAuth.noBrowserMethod', 'OpenCode does not currently expose browser login for {{provider}} in this runtime. Use the API key field, or update OpenCode when this provider adds subscription login support.', {
    provider: suggestedAuthLabel(providerId, providerName, copyMode),
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
  copyMode?: CopyMode
  onBeforeAuthorize?: () => Promise<boolean>
  onAuthUpdated?: () => void | Promise<void>
}

type PendingAuth =
  | { kind: 'code'; method: number }
  | { kind: 'browser'; method: number; instructions: string | null }

function deviceCodeFromInstructions(instructions: string) {
  const normalizeCandidate = (candidate: string) => {
    const groups = candidate.split(/[ -]+/).filter(Boolean)
    const normalized = groups.join('').toUpperCase()
    if (groups.length < 2 || !groups.every((group) => group.length === 4)) return null
    if (groups[0]?.toUpperCase() === 'CODE') return null
    if (!/[A-Z]/.test(normalized)) return null
    return groups.map((group) => group.toUpperCase()).join('-')
  }

  const contextualPatterns = [
    /\bcode[^a-z0-9\n]{1,20}([a-z0-9]{4}(?:[ -][a-z0-9]{4}){1,2})\b/i,
    /\b(?:enter|paste)[^a-z0-9\n]{1,40}(?:code[^a-z0-9\n]{1,20})?([a-z0-9]{4}(?:[ -][a-z0-9]{4}){1,2})\b/i,
  ]
  for (const pattern of contextualPatterns) {
    const contextual = instructions.match(pattern)
    if (!contextual?.[1]) continue
    const normalized = normalizeCandidate(contextual[1])
    if (normalized) return normalized
  }

  for (const match of instructions.matchAll(/\b([a-z0-9]{4}(?:[ -][a-z0-9]{4}){1,2})\b/gi)) {
    const normalized = normalizeCandidate(match[1] || '')
    if (!normalized) continue
    return normalized
  }
  return null
}

function copyPayloadForAuthInstructions(instructions: string) {
  const trimmed = instructions.trim()
  return deviceCodeFromInstructions(trimmed) || trimmed
}

export function ProviderAuthControls({
  providerId,
  providerName,
  connected,
  disabled,
  copyMode = 'settings',
  onBeforeAuthorize,
  onAuthUpdated,
}: Props) {
  const pollDelayTimersRef = useRef(new Set<{
    id: ReturnType<typeof setTimeout>
    resolve: (completed: boolean) => void
  }>())
  const [methods, setMethods] = useState<ProviderAuthMethod[]>([])
  const [loading, setLoading] = useState(false)
  const [authorizing, setAuthorizing] = useState<number | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null)
  const [code, setCode] = useState('')
  const [methodInputs, setMethodInputs] = useState<Record<number, Record<string, string>>>({})

  useEffect(() => () => {
    for (const timer of pollDelayTimersRef.current) {
      clearTimeout(timer.id)
      timer.resolve(false)
    }
    pollDelayTimersRef.current.clear()
  }, [])

  const waitForProviderPoll = useCallback((ms: number) => new Promise<boolean>((resolve) => {
    let timer!: {
      id: ReturnType<typeof setTimeout>
      resolve: (completed: boolean) => void
    }
    timer = {
      id: setTimeout(() => {
        pollDelayTimersRef.current.delete(timer)
        resolve(true)
      }, ms),
      resolve,
    }
    pollDelayTimersRef.current.add(timer)
  }), [])

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
    setPendingAuth(null)
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
    setPendingAuth(null)
    try {
      if (onBeforeAuthorize) {
        const ok = await onBeforeAuthorize()
        if (!ok) return
      }

      const latestMethods = methods.length > 0 ? methods : await loadMethods()
      const selectedIndex = methodIndex ?? latestMethods.findIndex((method) => method.type === 'oauth')
      const selected = selectedIndex >= 0 ? latestMethods[selectedIndex] : null
      if (!selected || selected.type !== 'oauth') {
        setStatus(copyMode === 'setup'
          ? t('providerAuth.noOauthMethodSetup', 'Browser sign-in is not available for this provider. Use the API key field.')
          : t('providerAuth.noOauthMethod', 'OpenCode did not expose a subscription login method for this provider. Use the API key field or update the bundled OpenCode runtime.'))
        return
      }

      const authorization = await window.coworkApi.provider.authorize(
        providerId,
        selectedIndex,
        methodInputs[selectedIndex] || {},
      )
      if (!authorization) {
        setStatus(copyMode === 'setup'
          ? t('providerAuth.noAuthorizationSetup', 'The login URL was not returned. Close any stale browser login flow and try again.')
          : t('providerAuth.noAuthorization', 'OpenCode did not return a login URL. Its local callback server may already be running or blocked; close any stale OpenCode login flow and try again.'))
        return
      }
      if (authorization.method === 'code') {
        setPendingAuth({ kind: 'code', method: selectedIndex })
        setStatus(authorization.instructions || t('providerAuth.enterCode', 'Complete the browser login, then paste the authorization code here.'))
      } else {
        const instructions = authorization.instructions?.trim() || null
        setPendingAuth({ kind: 'browser', method: selectedIndex, instructions })
        setStatus(instructions
          ? t('providerAuth.browserOpenedWithInstructions', 'Browser login opened. Follow the instructions below, then return here and confirm so Open Cowork can verify the new login.')
          : t('providerAuth.browserOpened', 'Browser login opened. Complete the flow there, then return here and confirm so Open Cowork can verify the new login.'))
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setAuthorizing(null)
    }
  }

  const completeCodeFlow = async () => {
    if (!providerId || pendingAuth?.kind !== 'code') return
    const pending = pendingAuth
    setAuthorizing(pending.method)
    setStatus(null)
    try {
      const ok = await window.coworkApi.provider.callback(providerId, pending.method, code.trim())
      setStatus(ok
        ? t('providerAuth.connected', 'Provider login completed.')
        : t('providerAuth.callbackFailed', 'Provider login did not complete. Try the login flow again.'))
      if (ok) {
        if (!await verifyProviderConnected()) {
          setStatus(copyMode === 'setup'
            ? t('providerAuth.notVerifiedSetup', 'This provider is not signed in yet. Finish the browser login, then try confirming again.')
            : t('providerAuth.notVerified', 'OpenCode still does not report this provider as signed in. Finish the browser login, then try confirming again.'))
          return
        }
        setPendingAuth(null)
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
        if (!await waitForProviderPoll(1_000)) return false
      }
      return false
    }

    setStatus(t('providerAuth.verifying', 'Checking provider login status...'))
    if (await checkCurrentRuntime(5)) return true

    setStatus(copyMode === 'setup'
      ? t('providerAuth.reloadingRuntimeSetup', 'Refreshing the model service to pick up the provider login...')
      : t('providerAuth.reloadingRuntime', 'Reloading OpenCode to pick up the provider login...'))
    const runtimeStatus = await window.coworkApi.runtime.restart()
    if (!runtimeStatus.ready) return false
    return checkCurrentRuntime(5)
  }

  const finishBrowserLogin = async () => {
    if (!providerId || pendingAuth?.kind !== 'browser') return
    const pending = pendingAuth
    setAuthorizing(-1)
    setStatus(null)
    try {
      try {
        await window.coworkApi.provider.callback(providerId, pending.method)
      } catch {
        // Some providers consume the callback before the user returns to
        // Open Cowork. Provider verification below is the authoritative
        // success check for those already-completed browser flows.
      }

      if (!await verifyProviderConnected()) {
        setStatus(copyMode === 'setup'
          ? t('providerAuth.notVerifiedSetup', 'This provider is not signed in yet. Finish the browser login, then try confirming again.')
          : t('providerAuth.notVerified', 'OpenCode still does not report this provider as signed in. Finish the browser login, then try confirming again.'))
        return
      }
      await onAuthUpdated?.()
      setPendingAuth(null)
      setStatus(t('providerAuth.connected', 'Provider login completed.'))
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setAuthorizing(null)
    }
  }

  const forgetProviderLogin = async () => {
    if (!providerId) return
    setAuthorizing(-1)
    setStatus(null)
    try {
      await window.coworkApi.provider.logout(providerId)
      setPendingAuth(null)
      setCode('')
      setStatus(t('providerAuth.removed', 'Provider login removed. Sign in again to refresh the token.'))
      await onAuthUpdated?.()
      void loadMethods()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setAuthorizing(null)
    }
  }

  const entries = oauthMethods
  const copyBrowserLoginInstructions = async () => {
    if (pendingAuth?.kind !== 'browser' || !pendingAuth.instructions) return
    const copied = await writeTextToClipboard(copyPayloadForAuthInstructions(pendingAuth.instructions))
    setStatus(copied
      ? t('providerAuth.instructionsCopied', 'Login instructions copied to clipboard.')
      : t('providerAuth.instructionsCopyFailed', 'Could not copy login instructions. Select the instructions and copy them manually.'))
  }
  const pendingCodeAuth = pendingAuth?.kind === 'code' ? pendingAuth : null
  const pendingBrowserAuth = pendingAuth?.kind === 'browser' ? pendingAuth : null

  return (
    <div className="flex flex-col gap-3">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">
        {copyMode === 'setup'
          ? t('providerAuth.headerSetup', 'Browser sign-in')
          : t('providerAuth.header', 'OpenCode login')}
      </span>
      <div className="rounded-2xl border border-border-subtle p-4 flex flex-col gap-3">
        <div className="text-[11px] text-text-muted leading-relaxed">
          {copyMode === 'setup'
            ? t('providerAuth.descriptionSetup', 'Use provider sign-in for subscriptions or OAuth, or keep using the API key field.')
            : t('providerAuth.description', 'Use OpenCode-native provider auth for subscriptions/OAuth, or keep using the API key field above.')}
        </div>
        {connected === false ? (
          <div className="rounded-xl border border-border-subtle px-3 py-2 text-[11px] leading-relaxed" style={{ background: 'var(--color-surface)' }}>
            {copyMode === 'setup'
              ? t('providerAuth.notConnectedSetup', 'This provider is not signed in yet. Sign in below or enter an API key.')
              : t('providerAuth.notConnected', 'OpenCode does not currently report this provider as signed in. Sign in below or enter an API key above, then save before chatting.')}
          </div>
        ) : null}
        {connected === true ? (
          <div className="rounded-xl border border-border-subtle px-3 py-2 text-[11px] leading-relaxed flex items-center justify-between gap-3" style={{ color: 'var(--color-green)', background: 'var(--color-surface)' }}>
            <span>
              {copyMode === 'setup'
                ? t('providerAuth.connectedStatusSetup', 'This provider is signed in.')
                : t('providerAuth.connectedStatus', 'OpenCode reports this provider is signed in.')}
            </span>
            <button
              type="button"
              onClick={forgetProviderLogin}
              disabled={authorizing !== null}
              className="shrink-0 px-2 py-1 rounded-lg border border-border-subtle text-[11px] font-semibold text-text hover:bg-surface-hover cursor-pointer disabled:opacity-60 disabled:cursor-wait"
            >
              {t('providerAuth.forgetLogin', 'Forget login')}
            </button>
          </div>
        ) : null}
        {!loading && entries.length === 0 ? (
          <div className="rounded-xl border border-border-subtle px-3 py-2 text-[11px] leading-relaxed" style={{ background: 'var(--color-surface)' }}>
            {noBrowserMethodMessage(providerId, providerName, copyMode)}
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
        {pendingCodeAuth ? (
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
        {pendingBrowserAuth ? (
          <div className="flex flex-col gap-2">
            {pendingBrowserAuth.instructions ? (
              <div className="rounded-xl border border-border-subtle p-3 flex flex-col gap-2" style={{ background: 'var(--color-surface)' }}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-text">
                    {t('providerAuth.loginInstructions', 'Login instructions')}
                  </span>
                  <button
                    type="button"
                    onClick={() => void copyBrowserLoginInstructions()}
                    className="shrink-0 px-2 py-1 rounded-lg border border-border-subtle text-[11px] font-semibold text-text hover:bg-surface-hover cursor-pointer"
                  >
                    {t('providerAuth.copyInstructions', 'Copy')}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text">
                  {pendingBrowserAuth.instructions}
                </pre>
              </div>
            ) : null}
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
          </div>
        ) : null}
        {status ? <div className="text-[11px] text-text-muted leading-relaxed">{status}</div> : null}
      </div>
    </div>
  )
}
