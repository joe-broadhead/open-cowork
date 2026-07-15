import { useMemo } from 'react'
import type { CapabilityRiskLevel } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { writeTextToClipboard } from '../../helpers/clipboard'
import type { CapabilityRelationshipRow } from './capabilities-page-support'
import { EmptyGrid } from './capabilities-page-components'
import { Badge, Button, Card, type BadgeTone } from '@open-cowork/ui'

type Props = {
  rows: CapabilityRelationshipRow[]
  allRowsCount: number
  onOpenTool: (toolId: string) => void
  onOpenSkill: (skillName: string) => void
}

const RISK_TONE: Record<CapabilityRiskLevel, BadgeTone> = {
  low: 'muted',
  medium: 'warning',
  high: 'danger',
}

type ConsumerMatrixCapability = {
  id: string
  label: string
  type: CapabilityRelationshipRow['type']
  risk: CapabilityRiskLevel
  policyState: string
  credentialState: string
}

type ConsumerMatrixRow = {
  id: string
  name: string
  kind: string
  source: string
  capabilities: ConsumerMatrixCapability[]
  highestRisk: CapabilityRiskLevel
}

function riskLabel(risk: CapabilityRiskLevel) {
  return risk === 'high' ? 'High risk' : risk === 'medium' ? 'Medium risk' : 'Low risk'
}

function statusTone(state: string): BadgeTone {
  if (state === 'missing' || state === 'disabled' || state === 'credential_missing') return 'danger'
  if (state === 'unknown') return 'warning'
  return 'success'
}

function consumerKindLabel(kind: string) {
  if (kind === 'agent') return t('capabilities.relationships.kindCoworker', 'coworker')
  if (kind === 'workflow') return t('capabilities.relationships.kindPlaybook', 'playbook')
  return kind
}

function consumerMatrixKey(consumer: { kind: string; id: string }) {
  return `${consumer.kind}:${consumer.id}`
}

function buildConsumerMatrixRows(rows: CapabilityRelationshipRow[]) {
  const grouped = new Map<string, ConsumerMatrixRow>()

  for (const row of rows) {
    for (const consumer of row.consumers) {
      const key = consumerMatrixKey(consumer)
      const existing = grouped.get(key)
      const next = existing || {
        id: key,
        name: consumer.name,
        kind: consumer.kind,
        source: consumer.source,
        capabilities: [],
        highestRisk: 'low' as CapabilityRiskLevel,
      }
      next.capabilities.push({
        id: row.id,
        label: row.label,
        type: row.type,
        risk: row.risk,
        policyState: row.accessPolicy.state,
        credentialState: row.credentialHealth.state,
      })
      next.highestRisk = highestRisk(next.highestRisk, row.risk)
      grouped.set(key, next)
    }
  }

  return Array.from(grouped.values())
    .map((row) => ({
      ...row,
      capabilities: row.capabilities.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
    }))
    .sort((a, b) => (
      RISK_RANK[b.highestRisk] - RISK_RANK[a.highestRisk]
      || b.capabilities.length - a.capabilities.length
      || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    ))
}

const RISK_RANK: Record<CapabilityRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
}

function highestRisk(a: CapabilityRiskLevel, b: CapabilityRiskLevel) {
  return RISK_RANK[b] > RISK_RANK[a] ? b : a
}

function impactedConsumerText(rows: CapabilityRelationshipRow[]) {
  const matrixRows = buildConsumerMatrixRows(rows)
  return matrixRows.map((row) => {
    const capabilities = row.capabilities.map((capability) => `${capability.label} (${capability.risk}, ${capability.policyState})`).join(', ')
    return `${row.name}: ${capabilities}`
  }).join('\n')
}

function copyImpactedConsumers(rows: CapabilityRelationshipRow[]) {
  void writeTextToClipboard(impactedConsumerText(rows))
}

export function CapabilityRelationshipView({ rows, allRowsCount, onOpenTool, onOpenSkill }: Props) {
  const highRiskCount = rows.filter((row) => row.risk === 'high').length
  const writeCapableCount = rows.filter((row) => row.writeCapable).length
  const missingCredentialCount = rows.filter((row) => row.credentialHealth.state === 'missing' || row.credentialHealth.state === 'disabled').length
  const consumerCount = rows.reduce((count, row) => count + row.consumers.length, 0)
  const consumerRows = useMemo(() => buildConsumerMatrixRows(rows), [rows])

  if (allRowsCount === 0) {
    return <EmptyGrid message={t('capabilities.relationshipsEmpty', 'No tool or skill relationships are available yet.')} />
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Metric label={t('capabilities.relationships.total', 'Tools & skills')} value={rows.length} detail={t('capabilities.relationships.visible', 'Visible in matrix')} emphasis />
        <Metric label={t('capabilities.relationships.highRisk', 'High risk')} value={highRiskCount} detail={t('capabilities.relationships.highRiskDetail', 'Needs review')} />
        <Metric label={t('capabilities.relationships.writeCapable', 'Write capable')} value={writeCapableCount} detail={t('capabilities.relationships.writeDetail', 'Mutates state')} />
        <Metric label={t('capabilities.relationships.consumers', 'Consumers')} value={consumerCount} detail={missingCredentialCount > 0 ? `${missingCredentialCount} auth issue${missingCredentialCount === 1 ? '' : 's'}` : t('capabilities.relationships.consumerDetail', 'Known links')} />
      </div>

      <Card style={{ padding: 0 }}>
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
          <div>
            <h2 className="font-display text-role-card-title font-bold text-text">{t('capabilities.relationships.consumerMatrixTitle', 'Consumer access matrix')}</h2>
            <div className="mt-0.5 text-2xs text-text-muted">
              {t('capabilities.relationships.consumerMatrixSubtitle', 'Rows are coworkers and playbooks; cells summarize the OpenCode tools and skills they inherit or request.')}
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => copyImpactedConsumers(rows)}
            disabled={consumerRows.length === 0}
            className="shrink-0"
          >
            {t('capabilities.relationships.copyConsumers', 'Copy consumers')}
          </Button>
        </div>
        {consumerRows.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyGrid message={t('capabilities.relationships.noConsumers', 'No known consumers matched this view.')} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-xs" aria-label={t('capabilities.relationships.consumerMatrixLabel', 'Consumer access matrix')}>
              <thead className="border-b border-border-subtle text-2xs uppercase tracking-[0.12em] text-text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">{t('capabilities.relationships.consumer', 'Consumer')}</th>
                  <th className="px-4 py-3 font-medium">{t('capabilities.relationships.matrixCapabilityCells', 'Tools & skills')}</th>
                  <th className="px-4 py-3 font-medium">{t('capabilities.relationships.highestRisk', 'Highest risk')}</th>
                </tr>
              </thead>
              <tbody>
                {consumerRows.map((row) => (
                  <tr key={row.id} className="border-b border-border-subtle align-top last:border-b-0">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-text">{row.name}</div>
                      <div className="mt-1 text-2xs capitalize text-text-muted">{consumerKindLabel(row.kind)}</div>
                      <div className="mt-1 text-2xs text-text-secondary">{row.source}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex max-w-[620px] flex-wrap gap-1.5">
                        {row.capabilities.map((capability) => (
                          <Badge key={`${row.id}:${capability.id}`} tone="muted" title={`${capability.policyState} / ${capability.credentialState}`}>
                            {capability.label} · {capability.policyState.replace(/_/g, ' ')}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={RISK_TONE[row.highestRisk]} className="capitalize">{riskLabel(row.highestRisk)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card style={{ padding: 0 }}>
        <div className="border-b border-border-subtle px-4 py-3">
          <h2 className="font-display text-role-card-title font-bold text-text">{t('capabilities.relationships.matrixTitle', 'Access matrix')}</h2>
          <div className="mt-0.5 text-2xs text-text-muted">
            {t('capabilities.relationships.matrixSubtitle', 'Tool and skill rows show risk, credential health, access policy, known consumers, and remediation entry points.')}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyGrid message={t('capabilities.relationships.noMatch', 'No tool or skill relationships matched your search.')} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] border-collapse text-left text-xs" aria-label={t('capabilities.relationships.capabilityMatrixLabel', 'Tool and skill access matrix')}>
              <thead className="border-b border-border-subtle text-2xs uppercase tracking-[0.12em] text-text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">{t('capabilities.relationships.capability', 'Tool or skill')}</th>
                  <th className="px-4 py-3 font-medium">{t('capabilities.relationships.risk', 'Risk')}</th>
                  <th className="px-4 py-3 font-medium">{t('capabilities.relationships.credentials', 'Credentials')}</th>
                  <th className="px-4 py-3 font-medium">{t('capabilities.relationships.policy', 'Policy')}</th>
                  <th className="px-4 py-3 font-medium">{t('capabilities.relationships.consumersColumn', 'Consumers')}</th>
                  <th className="px-4 py-3 font-medium">{t('capabilities.relationships.actions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border-subtle align-top last:border-b-0">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-text">{row.label}</div>
                      <div className="mt-1 line-clamp-2 max-w-[260px] text-2xs leading-5 text-text-secondary">{row.description}</div>
                      <div className="mt-2 text-2xs uppercase tracking-[0.1em] text-text-muted">{row.source}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={RISK_TONE[row.risk]} className="capitalize">{riskLabel(row.risk)}</Badge>
                      <div className="mt-2 max-w-[190px] text-2xs leading-5 text-text-secondary">{row.riskReason}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={statusTone(row.credentialHealth.state)} className="capitalize">{row.credentialHealth.label}</Badge>
                      {row.credentialHealth.detail ? <div className="mt-2 max-w-[180px] text-2xs leading-5 text-text-secondary">{row.credentialHealth.detail}</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={statusTone(row.accessPolicy.state)} className="capitalize">{row.accessPolicy.state.replace(/_/g, ' ')}</Badge>
                      <div className="mt-2 max-w-[190px] text-2xs leading-5 text-text-secondary">{row.accessPolicy.reason}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex max-w-[260px] flex-wrap gap-1.5">
                        {row.consumers.slice(0, 6).map((consumer) => (
                          <Badge key={`${consumer.kind}:${consumer.id}`} tone="muted" title={consumer.source}>
                            {consumer.name}
                          </Badge>
                        ))}
                        {row.consumers.length > 6 ? <span className="text-2xs text-text-muted">+{row.consumers.length - 6}</span> : null}
                        {row.consumers.length === 0 ? <span className="text-2xs text-text-muted">No known consumers</span> : null}
                      </div>
                      {row.requiredCapabilities.length > 0 ? (
                        <div className="mt-2 text-2xs text-text-muted">Requires {row.requiredCapabilities.join(', ')}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => row.type === 'tool' ? onOpenTool(row.id.replace(/^tool:/, '')) : onOpenSkill(row.id.replace(/^skill:/, ''))}
                      >
                        {row.type === 'tool' ? t('capabilities.relationships.openTool', 'Open tool') : t('capabilities.relationships.openSkill', 'Open skill')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {rows.length > 0 ? (
        <Card padding="sm">
          <h2 className="font-display text-role-card-title font-bold text-text">{t('capabilities.relationships.graphTitle', 'Dependency graph')}</h2>
          <div className="mt-0.5 text-2xs text-text-muted">{t('capabilities.relationships.graphSubtitle', 'A compact graph list optimized for scanning large inventories. Each line reads consumer to tool or skill, with skill requirements shown inline.')}</div>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {rows.slice(0, 12).map((row) => (
              <Card key={`${row.id}:graph`} variant="flat" padding="sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-text">{row.label}</div>
                    <div className="mt-1 text-2xs text-text-muted">{row.edges.length} edge{row.edges.length === 1 ? '' : 's'} · {row.methodsCount} method/link{row.methodsCount === 1 ? '' : 's'}</div>
                  </div>
                  <Badge tone={RISK_TONE[row.risk]} className="capitalize">{riskLabel(row.risk)}</Badge>
                </div>
                <div className="mt-2 text-2xs leading-5 text-text-secondary">
                  {row.consumers.length > 0 ? row.consumers.slice(0, 3).map((consumer) => consumer.name).join(' -> ') : 'No known inbound consumers'}
                  {' -> '}
                  {row.label}
                </div>
              </Card>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  )
}

function Metric({ label, value, detail, emphasis = false }: { label: string; value: number; detail: string; emphasis?: boolean }) {
  return (
    <Card padding="sm">
      <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="mt-1 flex items-end gap-2">
        <div className={`text-xl font-semibold leading-none ${emphasis ? 'text-accent' : 'text-text'}`}>{value}</div>
        <div className="pb-0.5 text-2xs text-text-muted">{detail}</div>
      </div>
    </Card>
  )
}
