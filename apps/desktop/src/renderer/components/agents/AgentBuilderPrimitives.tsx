import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { CustomAgentConfig, ProviderDescriptor, ProviderModelDescriptor } from '@open-cowork/shared'

import { t } from '../../helpers/i18n'
import { Badge, Button, Card, Input, SegmentedControl, Select } from '../ui'

export type WorkbenchTab = 'instructions' | 'capabilities' | 'inference' | 'preview'

type ResolvedModelSelection = {
  provider: ProviderDescriptor | null
  providerId: string | null
  modelId: string | null
  model: ProviderModelDescriptor | null
}

export function WorkbenchTabs({
  tab,
  onChange,
}: {
  tab: WorkbenchTab
  onChange: (next: WorkbenchTab) => void
}) {
  const tabs: Array<{ id: WorkbenchTab; label: string }> = [
    { id: 'capabilities', label: 'Capabilities' },
    { id: 'inference', label: 'Model & behavior' },
    { id: 'instructions', label: 'Instructions' },
    { id: 'preview', label: 'OpenCode Preview' },
  ]
  return (
    <div
      className="flex border-b"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      {tabs.map((entry) => (
        <button
          key={entry.id}
          onClick={() => onChange(entry.id)}
          className="flex-1 min-w-0 px-2.5 py-2.5 text-xs font-medium leading-tight cursor-pointer transition-colors"
          style={{
            color: tab === entry.id ? 'var(--color-text)' : 'var(--color-text-muted)',
            background: tab === entry.id ? 'var(--color-surface-active)' : 'transparent',
            borderBottom: tab === entry.id
              ? '2px solid var(--color-accent)'
              : '2px solid transparent',
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  )
}

export function ScopeRow({
  draft,
  projectTargetDirectory,
  onScopeChange,
  onChooseDirectory,
}: {
  draft: CustomAgentConfig
  projectTargetDirectory: string | null
  onScopeChange: (scope: 'machine' | 'project') => void
  onChooseDirectory: () => void
}) {
  return (
    <Card variant="surface" padding="md" className="mb-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-text">{t('agentBuilder.saveThisAgentIn', 'Save this coworker in')}</div>
          <div className="text-2xs text-text-muted mt-0.5">
            {draft.scope === 'project'
              ? projectTargetDirectory || 'Choose a project directory'
              : 'Machine scope - available across all your Cowork sessions'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl
            label={t('agentBuilder.saveThisAgentIn', 'Save this coworker in')}
            value={draft.scope === 'project' ? 'project' : 'machine'}
            onChange={(scope) => onScopeChange(scope as 'machine' | 'project')}
            options={[
              { value: 'machine', label: 'Machine' },
              { value: 'project', label: 'Project' },
            ]}
          />
          {draft.scope === 'project' && (
            <Button variant="secondary" size="sm" onClick={onChooseDirectory}>
              {projectTargetDirectory ? 'Change' : 'Choose directory'}
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}

export function InferenceTab({
  draft,
  readOnly,
  providers = [],
  defaultProviderId = null,
  catalogOverrides,
  onProviderCatalogRefresh,
  onRefreshProviderCatalog,
  onChange,
}: {
  draft: CustomAgentConfig
  readOnly?: boolean
  providers?: ProviderDescriptor[]
  defaultProviderId?: string | null
  catalogOverrides?: Record<string, ProviderModelDescriptor[]>
  onProviderCatalogRefresh?: (providerId: string, models: ProviderModelDescriptor[]) => void
  onRefreshProviderCatalog?: (providerId: string) => Promise<ProviderModelDescriptor[]>
  onChange: (patch: Partial<CustomAgentConfig>) => void
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null)
  const [localCatalogOverrides, setLocalCatalogOverrides] = useState<Record<string, ProviderModelDescriptor[]>>({})
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const effectiveCatalogOverrides = catalogOverrides ?? localCatalogOverrides
  const selection = useMemo(
    () => resolveAgentBuilderModelSelection(
      draft.model,
      providers,
      selectedProviderId || defaultProviderId,
      effectiveCatalogOverrides,
    ),
    [defaultProviderId, draft.model, effectiveCatalogOverrides, providers, selectedProviderId],
  )
  const models = selection.provider
    ? providerModelsFor(selection.provider, effectiveCatalogOverrides)
    : []
  const model = models.find((entry) => entry.id === selection.modelId) || selection.model
  const uncatalogedModelId = selection.modelId && !model ? selection.modelId : null
  const variants = model?.variants?.length ? model.variants : []
  const variantInCatalog = draft.variant ? variants.includes(draft.variant) : true
  const showCatalogVariantSelect = variants.length > 0 && variantInCatalog
  const showAdvancedVariant = !showCatalogVariantSelect
  const providerConnected = selection.provider?.connected !== false

  useEffect(() => {
    if ((draft.variant && showAdvancedVariant) || uncatalogedModelId) setAdvancedOpen(true)
  }, [draft.variant, showAdvancedVariant, uncatalogedModelId])

  useEffect(() => {
    if (!selection.providerId || !providers.length) return
    if (providers.some((provider) => provider.id === selection.providerId)) return
    const fallback = providers.find((provider) => provider.id === defaultProviderId) || providers[0]
    if (fallback) onChange({ model: null, variant: null })
  }, [defaultProviderId, onChange, providers, selection.providerId])

  const chooseProvider = (providerId: string) => {
    const provider = providers.find((entry) => entry.id === providerId) || null
    if (!provider) return
    setSelectedProviderId(provider.id)
    if (provider.connected === false) {
      onChange({ model: null, variant: null })
      return
    }
    const providerModels = providerModelsFor(provider, effectiveCatalogOverrides)
    const nextModelId = provider.defaultModel || providerModels[0]?.id || null
    onChange({
      model: nextModelId ? serializeAgentBuilderModelId(provider.id, nextModelId) : null,
      variant: null,
    })
  }

  const chooseModel = (modelId: string) => {
    if (!selection.providerId) return
    setSelectedProviderId(selection.providerId)
    onChange({
      model: modelId ? serializeAgentBuilderModelId(selection.providerId, modelId) : null,
      variant: null,
    })
  }

  const refreshCatalog = async () => {
    if (!selection.providerId || !onRefreshProviderCatalog) return
    setRefreshingProviderId(selection.providerId)
    setRefreshError(null)
    try {
      const refreshed = await onRefreshProviderCatalog(selection.providerId)
      if (refreshed.length > 0) {
        if (onProviderCatalogRefresh) {
          onProviderCatalogRefresh(selection.providerId, refreshed)
        } else {
          setLocalCatalogOverrides((current) => ({ ...current, [selection.providerId!]: refreshed }))
        }
      }
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : 'Could not refresh this provider catalog.')
    } finally {
      setRefreshingProviderId(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-2xs text-text-muted leading-relaxed">
        Optional overrides that control how this agent runs. Leave empty to inherit the session defaults.
      </p>
      <Field label="Provider" hint="Providers come from the configured runtime catalog. Not connected providers do not fabricate model lists.">
        {providers.length === 0 ? (
          <div className="rounded-xl border border-border-subtle bg-elevated px-3 py-2 text-2xs text-text-muted">
            No providers are configured. This agent will inherit the session model.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {providers.map((provider) => {
              const active = provider.id === selection.providerId
              return (
                <button
                  key={provider.id}
                  type="button"
                  disabled={readOnly}
                  aria-pressed={active}
                  onClick={() => chooseProvider(provider.id)}
                  className="agent-model-provider-option ui-polish-list-row rounded-xl border border-border-subtle bg-elevated px-3 py-2 text-start disabled:cursor-default"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-text">{provider.name}</span>
                    <span className={`text-2xs ${provider.connected === false ? 'text-amber' : 'text-green'}`}>
                      {provider.connected === false ? 'Not connected' : 'Ready'}
                    </span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-2xs text-text-muted">
                    {provider.description}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </Field>

      {selection.provider && !providerConnected ? (
        <div className="rounded-xl border border-border-subtle bg-elevated px-3 py-3">
          <div className="text-xs font-semibold text-text">{selection.provider.name} is not connected</div>
          <div className="mt-1 text-2xs leading-relaxed text-text-muted">
            Add credentials in Settings to load this provider's live model catalog. Advanced model ID remains available for power users.
          </div>
        </div>
      ) : null}

      {selection.provider && providerConnected && (
        <Field label="Model" hint="Context, reasoning, default, featured, and cost come from provider metadata.">
          <div className="flex items-center gap-2">
            <Select
              className="flex-1"
              value={selection.modelId || ''}
              disabled={readOnly || (models.length === 0 && !uncatalogedModelId)}
              onChange={(value) => chooseModel(value)}
              label={t('agentBuilder.modelSelect', 'Model')}
              options={[
                { value: '', label: 'Inherit session default' },
                ...(uncatalogedModelId ? [{ value: uncatalogedModelId, label: `Uncataloged: ${uncatalogedModelId}` }] : []),
                ...models.map((entry) => ({
                  value: entry.id,
                  label: `${entry.name || entry.id}`
                    + (selection.provider?.defaultModel === entry.id ? ' · Default' : '')
                    + (entry.featured ? ' · Featured' : '')
                    + (entry.reasoning ? ' · Reasoning' : '')
                    + (formatContextLength(entry.limit?.context ?? entry.contextLength) ? ` · ${formatContextLength(entry.limit?.context ?? entry.contextLength)}` : ''),
                })),
              ]}
            />
            {onRefreshProviderCatalog && (
              <Button
                variant="secondary"
                size="sm"
                disabled={readOnly || !selection.providerId || refreshingProviderId === selection.providerId}
                loading={refreshingProviderId === selection.providerId}
                onClick={() => void refreshCatalog()}
                className="shrink-0"
              >
                {refreshingProviderId === selection.providerId ? 'Refreshing…' : 'Refresh'}
              </Button>
            )}
          </div>
          {model ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {model.featured ? <MetaPill tone="accent">Featured</MetaPill> : null}
              {selection.provider.defaultModel === model.id ? <MetaPill tone="neutral">Default</MetaPill> : null}
              {model.reasoning ? <MetaPill tone="info">Reasoning</MetaPill> : null}
              {formatContextLength(model.limit?.context ?? model.contextLength) ? <MetaPill tone="neutral">{formatContextLength(model.limit?.context ?? model.contextLength)}</MetaPill> : null}
              {formatModelCost(model) ? <MetaPill tone="neutral">{formatModelCost(model)}</MetaPill> : null}
            </div>
          ) : null}
          {refreshError ? <span className="mt-1 block text-2xs text-red">{refreshError}</span> : null}
          {models.length === 0 ? (
            <div className="mt-2 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-2xs text-text-muted">
              No catalog models are loaded for this connected provider. Refresh the catalog or use the advanced model ID field.
            </div>
          ) : null}
        </Field>
      )}

      {showCatalogVariantSelect ? (
        <Field label="Variant" hint="Provider-specific reasoning or thinking mode.">
          <Select
            value={draft.variant ?? ''}
            disabled={readOnly}
            onChange={(value) => onChange({ variant: value.trim() === '' ? null : value })}
            label={t('agentBuilder.variantSelect', 'Variant')}
            options={[
              { value: '', label: 'Provider default' },
              ...variants.map((variant) => ({ value: variant, label: variant })),
            ]}
          />
        </Field>
      ) : null}

      <div className="rounded-xl border border-border-subtle bg-surface px-3 py-2">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          className="flex w-full items-center justify-between text-start text-2xs font-medium text-text-secondary"
          aria-expanded={advancedOpen}
        >
          Advanced model ID
          <span className="text-2xs text-text-muted">{advancedOpen ? 'Hide' : 'Show'}</span>
        </button>
        {advancedOpen && (
          <div className="mt-2">
            <Input
              type="text"
              value={draft.model ?? ''}
              readOnly={readOnly}
              onChange={(event) => onChange({ model: event.target.value.trim() === '' ? null : event.target.value })}
              placeholder="openrouter/anthropic/claude-sonnet-4"
              aria-label={t('agentBuilder.advancedModelId', 'Advanced model ID')}
            />
            <span className="mt-1 block text-2xs text-text-muted">
              Use this for provider models not yet present in the catalog. The saved shape remains the existing provider/model string.
            </span>
            {showAdvancedVariant ? (
              <div className="mt-2">
                <Input
                  type="text"
                  value={draft.variant ?? ''}
                  readOnly={readOnly}
                  onChange={(event) => onChange({ variant: event.target.value.trim() === '' ? null : event.target.value })}
                  placeholder="reasoning"
                  aria-label={t('agentBuilder.advancedVariant', 'Advanced variant')}
                />
                <span className="mt-1 block text-2xs text-text-muted">
                  Optional provider-specific mode for uncataloged models.
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <Field label="Temperature" hint="Lower = deterministic, higher = creative. Leave blank to inherit.">
        <Input
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={draft.temperature ?? ''}
          readOnly={readOnly}
          onChange={(event) => {
            const parsed = event.target.value === '' ? null : Number(event.target.value)
            onChange({ temperature: parsed !== null && Number.isFinite(parsed) ? parsed : null })
          }}
          placeholder="0.0 - 2.0"
          aria-label={t('agentBuilder.temperature', 'Temperature')}
        />
      </Field>
      <Field label="Max steps" hint="Cap the coworker's tool loop to prevent runaway iterations">
        <Input
          type="number"
          step="1"
          min="1"
          value={draft.steps ?? ''}
          readOnly={readOnly}
          onChange={(event) => {
            const parsed = event.target.value === '' ? null : Number(event.target.value)
            onChange({ steps: parsed !== null && Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null })
          }}
          placeholder="20"
          aria-label={t('agentBuilder.maxSteps', 'Max steps')}
        />
      </Field>
    </div>
  )
}

export function serializeAgentBuilderModelId(providerId: string, modelId: string): string {
  return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`
}

function providerModelsFor(
  provider: ProviderDescriptor,
  catalogOverrides: Record<string, ProviderModelDescriptor[]>,
): ProviderModelDescriptor[] {
  const override = catalogOverrides[provider.id]
  if (!override || override.length === 0) return provider.models
  const refreshedById = new Map(
    override.map((model) => [normalizeProviderModelId(provider.id, model.id), model]),
  )
  const configuredIds = new Set(provider.models.map((model) => normalizeProviderModelId(provider.id, model.id)))
  return [
    ...provider.models.map((model) => {
      const refreshed = refreshedById.get(normalizeProviderModelId(provider.id, model.id))
      if (!refreshed) return model
      const merged: ProviderModelDescriptor = { ...refreshed, ...model }
      if (refreshed.reasoning) merged.reasoning = true
      if (refreshed.variants?.length) merged.variants = refreshed.variants
      return merged
    }),
    ...override.filter((model) => !configuredIds.has(normalizeProviderModelId(provider.id, model.id))),
  ]
}

function normalizeProviderModelId(providerId: string, modelId: string): string {
  const prefix = `${providerId}/`
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId
}

export function resolveAgentBuilderModelSelection(
  draftModel: string | null | undefined,
  providers: ProviderDescriptor[],
  defaultProviderId?: string | null,
  catalogOverrides: Record<string, ProviderModelDescriptor[]> = {},
): ResolvedModelSelection {
  const trimmed = draftModel?.trim() || ''
  for (const provider of providers) {
    if (trimmed.startsWith(`${provider.id}/`)) {
      const modelId = trimmed.slice(provider.id.length + 1) || null
      const models = providerModelsFor(provider, catalogOverrides)
      const model = models.find((entry) => (
        entry.id === modelId ||
        entry.id === trimmed ||
        `${provider.id}/${entry.id}` === trimmed
      )) || null
      return {
        provider,
        providerId: provider.id,
        modelId: model?.id || modelId,
        model,
      }
    }
  }

  if (trimmed) {
    for (const provider of providers) {
      const models = providerModelsFor(provider, catalogOverrides)
      const model = models.find((entry) => entry.id === trimmed || `${provider.id}/${entry.id}` === trimmed)
      if (model) {
        return { provider, providerId: provider.id, modelId: model.id, model }
      }
    }
  }

  const provider = providers.find((entry) => entry.id === defaultProviderId) || providers[0] || null
  if (!provider) return { provider: null, providerId: null, modelId: trimmed || null, model: null }
  const models = providerModelsFor(provider, catalogOverrides)
  return {
    provider,
    providerId: provider.id,
    modelId: trimmed || null,
    model: trimmed ? models.find((entry) => entry.id === trimmed) || null : null,
  }
}

function formatContextLength(tokens?: number | null): string | null {
  if (!tokens || !Number.isFinite(tokens)) return null
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M ctx`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`
  return `${tokens} ctx`
}

function formatModelCost(model: ProviderModelDescriptor): string | null {
  const input = model.cost?.input
  const output = model.cost?.output
  if (typeof input !== 'number' && typeof output !== 'number') return null
  if (typeof input === 'number' && typeof output === 'number') return `$${input}/$${output} per 1M`
  if (typeof input === 'number') return `$${input} input per 1M`
  return `$${output} output per 1M`
}

function MetaPill({ tone, children }: { tone: 'neutral' | 'accent' | 'info'; children: ReactNode }) {
  return <Badge tone={tone}>{children}</Badge>
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-medium text-text-secondary">{label}</span>
      {children}
      {hint && <span className="text-2xs text-text-muted">{hint}</span>}
    </div>
  )
}
