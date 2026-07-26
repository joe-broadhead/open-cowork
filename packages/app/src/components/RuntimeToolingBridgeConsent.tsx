import {
  RUNTIME_TOOLING_BRIDGE_CATEGORIES,
  RUNTIME_TOOLING_BRIDGE_PROJECTIONS,
  normalizeRuntimeToolingBridgeConsent,
  type BridgeProjection,
  type RuntimeToolingBridgeCategoryId,
  type RuntimeToolingBridgeConsent,
} from '@open-cowork/shared'
import { Card, Switch } from '@open-cowork/ui'
import { t } from '../helpers/i18n'

function displayHomePath(relativePath: string) {
  return `~/${relativePath}`
}

function accessModeLabel(accessMode: BridgeProjection['accessMode']) {
  if (accessMode === 'read-write-link') {
    return t(
      'settings.toolingBridge.accessMode.readWriteLink',
      'Read and change (linked host file)',
    )
  }
  return accessMode
}

export function RuntimeToolingBridgeConsentPanel({
  consent,
  onChange,
  id = 'runtime-tooling-bridge-consent',
  disabled = false,
}: {
  consent: RuntimeToolingBridgeConsent
  onChange: (consent: RuntimeToolingBridgeConsent) => void
  id?: string
  disabled?: boolean
}) {
  const normalized = normalizeRuntimeToolingBridgeConsent(consent)

  const updateCategory = (category: RuntimeToolingBridgeCategoryId, enabled: boolean) => {
    onChange({
      ...normalized,
      categories: {
        ...normalized.categories,
        [category]: enabled,
      },
    })
  }

  return (
    <Card id={id} className="flex flex-col gap-4 scroll-mt-4">
      <div>
        <div className="text-sm font-semibold text-text">
          {t('settings.toolingBridge.title', 'Developer tool access')}
        </div>
        <div className="mt-1 text-xs leading-relaxed text-text-muted">
          {t(
            'settings.toolingBridge.description',
            'Everything is off by default. Enable only the host tool files coworkers need. Enabled files are linked into the managed runtime and can be read or changed by tools.',
          )}
        </div>
        <div className="mt-2 text-xs leading-relaxed text-text-secondary">
          {t(
            'settings.toolingBridge.restartHint',
            'Saving restarts the managed runtime before the new access takes effect. Turning a category off removes only links created by Open Cowork.',
          )}
        </div>
        {disabled ? (
          <div role="status" className="mt-2 text-xs leading-relaxed text-text-muted">
            {t(
              'settings.toolingBridge.machineMode',
              'Developer tool access categories apply only to App isolated mode. Machine OpenCode uses its native home configuration instead.',
            )}
          </div>
        ) : null}
      </div>

      <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
        {RUNTIME_TOOLING_BRIDGE_CATEGORIES.map((category) => {
          const checked = normalized.categories[category.id]
          const label = t(`settings.toolingBridge.category.${category.id}.label`, category.label)
          const resourceDescriptionId = `${id}-${category.id}-resources`
          const capabilityDescriptionId = `${id}-${category.id}-capability`
          const projectionDescriptionId = `${id}-${category.id}-projections`
          const projections = RUNTIME_TOOLING_BRIDGE_PROJECTIONS.filter(
            ({ category: ownerCategory }) => ownerCategory === category.id,
          )
          return (
            <div key={category.id} className="flex items-start justify-between gap-4 px-3 py-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-text">{label}</div>
                <div
                  id={resourceDescriptionId}
                  className="mt-1 text-xs leading-relaxed text-text-muted"
                >
                  {t(
                    `settings.toolingBridge.category.${category.id}.resources`,
                    category.resourceSummary,
                  )}
                </div>
                <div
                  id={capabilityDescriptionId}
                  className="mt-1 text-xs leading-relaxed text-text-secondary"
                >
                  {t(
                    `settings.toolingBridge.category.${category.id}.capability`,
                    category.capabilitySummary,
                  )}
                </div>
                <div
                  id={projectionDescriptionId}
                  className="mt-2 text-2xs leading-relaxed text-text-muted"
                >
                  <div className="font-medium text-text-secondary">
                    {t('settings.toolingBridge.pathsAndAccess', 'Host path → runtime path · access')}
                  </div>
                  <ul className="mt-1 list-disc space-y-1 ps-4">
                    {projections.map((projection) => (
                      <li key={projection.id}>
                        <span className="sr-only">
                          {t('settings.toolingBridge.hostPath', 'Host path')}
                          {': '}
                        </span>
                        <code>{displayHomePath(projection.sourceRelativePath)}</code>
                        <span aria-hidden="true"> → </span>
                        <span className="sr-only">
                          {t('settings.toolingBridge.runtimePath', 'runtime path')}
                          {': '}
                        </span>
                        <code>{displayHomePath(projection.runtimeDestination)}</code>
                        {' · '}
                        {accessModeLabel(projection.accessMode)}
                      </li>
                    ))}
                    {category.id === 'ssh' ? (
                      <li>
                        <code>$SSH_AUTH_SOCK</code>
                        <span aria-hidden="true"> → </span>
                        {t(
                          'settings.toolingBridge.sshAgentDestination',
                          'managed runtime environment',
                        )}
                        {' · '}
                        {t(
                          'settings.toolingBridge.sshAgentAccess',
                          'SSH agent broker access',
                        )}
                      </li>
                    ) : null}
                  </ul>
                </div>
              </div>
              <Switch
                checked={checked}
                onCheckedChange={(enabled) => updateCategory(category.id, enabled)}
                disabled={disabled}
                aria-describedby={[
                  resourceDescriptionId,
                  capabilityDescriptionId,
                  projectionDescriptionId,
                ].join(' ')}
                aria-label={t(
                  `settings.toolingBridge.category.${category.id}.toggle`,
                  `Allow ${category.label}`,
                )}
              />
            </div>
          )
        })}
      </div>
    </Card>
  )
}
