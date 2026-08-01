import { useEffect, useMemo, useState } from 'react'
import type { ProviderDescriptor, ProviderModelDescriptor } from '@open-cowork/shared'
import { Button, Input } from '@open-cowork/ui'
import { t } from '../helpers/i18n'

const RECOMMENDED_MODEL_LIMIT = 6
const MODEL_PAGE_SIZE = 30

function uniqueModels(models: Array<ProviderModelDescriptor | undefined>) {
  const seen = new Set<string>()
  return models.filter((model): model is ProviderModelDescriptor => {
    if (!model || seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

function recommendedSetupModels(provider: ProviderDescriptor, selectedModelId: string) {
  const defaultModel = provider.models.find((model) => model.id === provider.defaultModel)
  const selectedModel = provider.models.find((model) => model.id === selectedModelId)
  const featuredModels = provider.models.filter((model) => model.featured)
  return uniqueModels([defaultModel, selectedModel, ...featuredModels])
    .slice(0, RECOMMENDED_MODEL_LIMIT)
}

function modelMatches(provider: ProviderDescriptor, model: ProviderModelDescriptor, rawQuery: string) {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return true
  return [provider.id, provider.name, model.id, model.name]
    .some((value) => value.toLowerCase().includes(query))
}

export function SetupModelCatalog({
  provider,
  selectedModelId,
  onSelect,
}: {
  provider: ProviderDescriptor
  selectedModelId: string
  onSelect: (modelId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [browseAll, setBrowseAll] = useState(false)
  const [visibleCount, setVisibleCount] = useState(MODEL_PAGE_SIZE)
  const recommended = useMemo(
    () => recommendedSetupModels(provider, selectedModelId),
    [provider, selectedModelId],
  )
  const filtered = useMemo(
    () => provider.models.filter((model) => modelMatches(provider, model, query)),
    [provider, query],
  )
  const showingFullCatalog = browseAll || Boolean(query.trim())
  const visibleModels = showingFullCatalog ? filtered.slice(0, visibleCount) : recommended

  useEffect(() => {
    setVisibleCount(MODEL_PAGE_SIZE)
  }, [browseAll, provider.id, query])

  useEffect(() => {
    setQuery('')
    setBrowseAll(false)
  }, [provider.id])

  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        aria-label={t('setup.modelSearchLabel', 'Search models')}
        placeholder={t('setup.modelSearchPlaceholder', 'Search by provider, name, or model ID')}
        leftIcon="search"
        clearable
        onClear={() => setQuery('')}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted" aria-live="polite">
        <span>
          {showingFullCatalog
            ? t('setup.modelResultsCount', '{{visible}} of {{total}} models', {
                visible: visibleModels.length,
                total: filtered.length,
              })
            : recommended.length === 1
              ? t('setup.recommendedModelCountOne', '1 recommended model')
              : t('setup.recommendedModelCount', '{{count}} recommended models', { count: recommended.length })}
        </span>
        {!query.trim() ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setBrowseAll((current) => !current)}
          >
            {browseAll
              ? t('setup.showRecommendedModels', 'Show recommended')
              : t('setup.browseAllModels', 'Browse all {{count}} models', { count: provider.models.length })}
          </Button>
        ) : null}
      </div>

      {visibleModels.length ? (
        <div className="grid gap-2" role="list" aria-label={t('setup.modelResults', 'Model results')}>
          {visibleModels.map((model) => {
            const active = selectedModelId === model.id
            return (
              <div key={model.id} role="listitem">
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelect(model.id)}
                  className={`w-full rounded-xl border px-3.5 py-3 text-start transition-colors ${active ? 'border-accent bg-accent/10' : 'border-border-subtle hover:bg-surface-hover'}`}
                >
                  <span className={`block text-sm font-medium ${active ? 'text-accent' : 'text-text-secondary'}`}>{model.name}</span>
                  <span className="mt-1 block text-xs text-text-muted">{model.id}</span>
                  {model.description ? (
                    <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-text-muted">
                      {model.description}
                    </span>
                  ) : null}
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        <div role="status" className="rounded-xl border border-border-subtle bg-surface px-3 py-3 text-sm text-text-muted">
          {t('setup.noModelsFound', 'No models match that search.')}
        </div>
      )}

      {showingFullCatalog && visibleModels.length < filtered.length ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => setVisibleCount((current) => current + MODEL_PAGE_SIZE)}
        >
          {t('setup.showMoreModels', 'Show {{count}} more models', {
            count: Math.min(MODEL_PAGE_SIZE, filtered.length - visibleModels.length),
          })}
        </Button>
      ) : null}
    </div>
  )
}
