import { useCallback, useEffect, useState } from 'react'
import type { ProductMcpLinkKind, ProductMcpProbe } from '@open-cowork/shared'
import { Button, Card, Input } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'
import { confirmMcpRemoval } from '../../helpers/destructive-actions'

/**
 * Soft-link panel for optional local Gateway / Wiki CLIs (JOE-909).
 * Default off: never writes config until the operator clicks Link.
 */
export function ProductMcpLinkPanel({ onChanged }: { onChanged?: () => void }) {
  const [probes, setProbes] = useState<ProductMcpProbe[]>([])
  const [loading, setLoading] = useState(true)
  const [busyKind, setBusyKind] = useState<ProductMcpLinkKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wikiRoot, setWikiRoot] = useState('')
  const [gatewayCommand, setGatewayCommand] = useState('')
  const [wikiCommand, setWikiCommand] = useState('')
  const [tokenFile, setTokenFile] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (typeof window.coworkApi.custom.productMcpProbe !== 'function') {
        setProbes([])
        return
      }
      const next = await window.coworkApi.custom.productMcpProbe()
      setProbes(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setProbes([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const link = async (kind: ProductMcpLinkKind) => {
    setBusyKind(kind)
    setError(null)
    try {
      const result = await window.coworkApi.custom.productMcpLink({
        kind,
        command: kind === 'gateway' ? gatewayCommand || undefined : wikiCommand || undefined,
        wikiRoot: kind === 'wiki' ? wikiRoot || undefined : undefined,
        tokenFile: tokenFile || undefined,
      })
      if (!result.ok) {
        setError(`${result.message} ${result.installHint}`)
        return
      }
      await refresh()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKind(null)
    }
  }

  const unlink = async (probe: ProductMcpProbe) => {
    setBusyKind(probe.kind)
    setError(null)
    try {
      const target = { name: probe.name, scope: 'machine' as const, directory: null }
      const confirmation = await confirmMcpRemoval(target)
      if (!confirmation) return
      const ok = await window.coworkApi.custom.removeMcp(target, confirmation.token)
      if (!ok) {
        setError(t('productMcp.unlinkFailed', 'Could not unlink {label}.', { label: probe.label }))
        return
      }
      await refresh()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKind(null)
    }
  }

  if (loading && probes.length === 0) {
    return (
      <Card className="p-4 border border-border-subtle">
        <p className="text-sm text-text-muted">
          {t('productMcp.loading', 'Checking for local Gateway and Wiki…')}
        </p>
      </Card>
    )
  }

  return (
    <Card className="p-4 border border-border-subtle space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">
          {t('productMcp.title', 'Link local Gateway / Wiki')}
        </h3>
        <p className="text-xs text-text-muted mt-1">
          {t(
            'productMcp.subtitle',
            'Optional standalones. Desktop never enables these by default. Install the CLI, then link to add a machine-scope custom MCP.',
          )}
        </p>
      </div>

      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3">
        {probes.map((probe) => (
          <div
            key={probe.kind}
            className="rounded-lg border border-border-subtle bg-elevated/40 p-3 space-y-2"
            data-testid={`product-mcp-${probe.kind}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-text">{probe.label}</div>
                <div className="text-xs text-text-muted mt-0.5">
                  {probe.linked
                    ? t('productMcp.linked', 'Linked as custom MCP “{name}”.', { name: probe.name })
                    : probe.found
                      ? t('productMcp.found', 'Found: {path}', { path: probe.resolvedBinary || probe.name })
                      : t('productMcp.missing', 'Not found on PATH.')}
                </div>
                {!probe.found && !probe.linked ? (
                  <p className="text-xs text-text-muted mt-1">{probe.installHint}</p>
                ) : null}
              </div>
              <div className="flex gap-2 shrink-0">
                {probe.linked ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyKind === probe.kind}
                    onClick={() => void unlink(probe)}
                  >
                    {t('productMcp.unlink', 'Unlink')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={busyKind === probe.kind || (probe.kind === 'wiki' && !wikiRoot.trim())}
                    onClick={() => void link(probe.kind)}
                  >
                    {t('productMcp.link', 'Link')}
                  </Button>
                )}
              </div>
            </div>

            {probe.kind === 'gateway' && !probe.linked ? (
              <label className="block text-xs text-text-muted">
                {t('productMcp.commandOverride', 'Binary path (optional)')}
                <Input
                  className="mt-1"
                  value={gatewayCommand}
                  onChange={(event) => setGatewayCommand(event.target.value)}
                  placeholder="cowork-gateway"
                  aria-label={t('productMcp.gatewayCommand', 'Gateway binary path')}
                />
              </label>
            ) : null}

            {probe.kind === 'wiki' && !probe.linked ? (
              <>
                <label className="block text-xs text-text-muted">
                  {t('productMcp.wikiRoot', 'Wiki root (required)')}
                  <Input
                    className="mt-1"
                    value={wikiRoot}
                    onChange={(event) => setWikiRoot(event.target.value)}
                    placeholder="/path/to/wiki-workspace"
                    aria-label={t('productMcp.wikiRoot', 'Wiki root (required)')}
                  />
                </label>
                <label className="block text-xs text-text-muted">
                  {t('productMcp.commandOverride', 'Binary path (optional)')}
                  <Input
                    className="mt-1"
                    value={wikiCommand}
                    onChange={(event) => setWikiCommand(event.target.value)}
                    placeholder="cowork-wiki"
                    aria-label={t('productMcp.wikiCommand', 'Wiki binary path')}
                  />
                </label>
              </>
            ) : null}
          </div>
        ))}
      </div>

      <label className="block text-xs text-text-muted">
        {t('productMcp.tokenFile', 'Token file path (optional, owner-only; never paste secrets)')}
        <Input
          className="mt-1"
          value={tokenFile}
          onChange={(event) => setTokenFile(event.target.value)}
          placeholder="/path/to/token-file"
          aria-label={t('productMcp.tokenFile', 'Token file path (optional, owner-only; never paste secrets)')}
        />
      </label>
    </Card>
  )
}
