import type { ReactNode } from 'react'
import type {
  AgentMemoryEntry,
  DreamRun,
  ImprovementCandidateDiff,
  ImprovementEvidenceRef,
  ImprovementProposal,
} from '@open-cowork/shared'
import { t } from '../helpers/i18n'

const detailShellStyle = { boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 5%, transparent)' }
const MAX_PAYLOAD_PREVIEW_CHARS = 1200

function formatCount(value: number, singular: string, plural: string) {
  return `${value} ${value === 1 ? singular : plural}`
}

function shortHash(value: string | null) {
  if (!value) return t('homepage.card.none', 'None')
  if (value.length <= 24) return value
  return `${value.slice(0, 18)}...${value.slice(-6)}`
}

function formatIso(value: string | null) {
  if (!value) return t('homepage.card.notFinished', 'Not finished')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function jsonPreview(value: Record<string, unknown>) {
  try {
    const raw = JSON.stringify(value, null, 2)
    if (!raw) return '{}'
    return raw.length > MAX_PAYLOAD_PREVIEW_CHARS ? `${raw.slice(0, MAX_PAYLOAD_PREVIEW_CHARS)}...` : raw
  } catch {
    return t('homepage.card.unreadablePayload', 'Payload could not be displayed.')
  }
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[10px] font-medium text-text-muted">
      {children}
    </span>
  )
}

function FieldGrid({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <div className="grid grid-cols-2 gap-2 max-[720px]:grid-cols-1">
      {items.map((item) => (
        <div key={item.label} className="rounded-xl border border-border-subtle px-3 py-2">
          <div className="text-[9px] uppercase tracking-[0.1em] text-text-muted">{item.label}</div>
          <div className="mt-1 min-w-0 break-words text-[11px] font-medium text-text">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

function TagList({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
  if (items.length === 0) return <div className="text-[11px] text-text-muted">{emptyLabel}</div>
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Pill key={item}>{item}</Pill>
      ))}
    </div>
  )
}

function EvidenceList({ evidence }: { evidence: ImprovementEvidenceRef[] }) {
  if (evidence.length === 0) {
    return <div className="text-[11px] text-text-muted">{t('homepage.card.noEvidence', 'No evidence linked.')}</div>
  }
  return (
    <div className="space-y-2">
      {evidence.map((entry) => (
        <div key={`${entry.kind}:${entry.id}`} className="rounded-xl border border-border-subtle px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">{entry.kind}</span>
            <span className="max-w-full break-all font-mono text-[10px] text-text-muted">{entry.id}</span>
          </div>
          <div className="mt-1 text-[11px] font-medium text-text">{entry.label}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-muted">
            <span>{t('homepage.card.hash', 'Hash')}: {shortHash(entry.hash)}</span>
            {entry.uri ? <span className="break-all">{entry.uri}</span> : null}
          </div>
        </div>
      ))}
    </div>
  )
}

function DiffList({ diffs }: { diffs: ImprovementCandidateDiff[] }) {
  if (diffs.length === 0) {
    return <div className="text-[11px] text-text-muted">{t('homepage.card.noCandidateDiffs', 'No candidate diffs attached.')}</div>
  }
  return (
    <div className="space-y-2">
      {diffs.map((diff, index) => (
        <div key={`${diff.targetType}:${diff.targetId || 'new'}:${diff.operation}:${index}`} className="rounded-xl border border-border-subtle px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">{diff.operation}</span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-text-muted">{diff.targetType.replace(/_/g, ' ')}</span>
          </div>
          <div className="mt-1 text-[11px] text-text-secondary leading-relaxed">{diff.summary}</div>
          <div className="mt-2 grid grid-cols-2 gap-2 max-[720px]:grid-cols-1">
            <div className="rounded-lg bg-bg px-2.5 py-2">
              <div className="text-[9px] uppercase tracking-[0.1em] text-text-muted">{t('homepage.card.beforeHash', 'Before hash')}</div>
              <div className="mt-1 break-all font-mono text-[10px] text-text-secondary">{shortHash(diff.beforeHash)}</div>
            </div>
            <div className="rounded-lg bg-bg px-2.5 py-2">
              <div className="text-[9px] uppercase tracking-[0.1em] text-text-muted">{t('homepage.card.afterHash', 'After hash')}</div>
              <div className="mt-1 break-all font-mono text-[10px] text-text-secondary">{shortHash(diff.afterHash)}</div>
            </div>
          </div>
          <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-bg p-2 text-[10px] leading-relaxed text-text-secondary">
            {jsonPreview(diff.payload)}
          </pre>
        </div>
      ))}
    </div>
  )
}

function InspectionDetails({
  label,
  meta,
  children,
}: {
  label: string
  meta: string
  children: ReactNode
}) {
  return (
    <details
      className="mt-3 rounded-2xl bg-bg px-3 py-2 open:pb-3"
      style={detailShellStyle}
    >
      <summary className="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        <span className="flex items-center justify-between gap-3">
          <span>{label}</span>
          <span className="text-text-muted">{meta}</span>
        </span>
      </summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  )
}

export function ProposalInspection({ proposal }: { proposal: ImprovementProposal }) {
  return (
    <InspectionDetails
      label={t('homepage.card.inspectProposal', 'Inspect evidence and diffs')}
      meta={`${formatCount(proposal.evidence.length, 'evidence', 'evidence')} / ${formatCount(proposal.candidateDiffs.length, 'diff', 'diffs')}`}
    >
      <FieldGrid
        items={[
          { label: t('homepage.card.target', 'Target'), value: `${proposal.targetType.replace(/_/g, ' ')}${proposal.targetId ? ` / ${proposal.targetId}` : ''}` },
          { label: t('homepage.card.updated', 'Updated'), value: formatIso(proposal.updatedAt) },
        ]}
      />
      <section>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.evidence', 'Evidence')}</div>
        <EvidenceList evidence={proposal.evidence} />
      </section>
      <section>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.candidateDiffs', 'Candidate diffs')}</div>
        <DiffList diffs={proposal.candidateDiffs} />
      </section>
    </InspectionDetails>
  )
}

export function MemoryInspection({ memory }: { memory: AgentMemoryEntry }) {
  return (
    <InspectionDetails
      label={t('homepage.card.inspectMemory', 'Inspect memory candidate')}
      meta={`${memory.privacy} / ${formatCount(memory.provenance.length, 'source', 'sources')}`}
    >
      <FieldGrid
        items={[
          { label: t('homepage.card.scope', 'Scope'), value: `${memory.scopeKind}${memory.scopeId ? ` / ${memory.scopeId}` : ''}` },
          { label: t('homepage.card.contentHash', 'Content hash'), value: shortHash(memory.contentHash) },
          { label: t('homepage.card.updated', 'Updated'), value: formatIso(memory.updatedAt) },
          { label: t('homepage.card.privacy', 'Privacy'), value: memory.privacy },
        ]}
      />
      <section>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.tags', 'Tags')}</div>
        <TagList items={memory.tags} emptyLabel={t('homepage.card.noTags', 'No tags attached.')} />
      </section>
      <section>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.body', 'Body')}</div>
        <div className="max-h-36 overflow-auto rounded-xl border border-border-subtle px-3 py-2 text-[11px] text-text-secondary leading-relaxed whitespace-pre-wrap">
          {memory.body}
        </div>
      </section>
      <section>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.provenance', 'Provenance')}</div>
        <EvidenceList evidence={memory.provenance} />
      </section>
    </InspectionDetails>
  )
}

export function DreamRunInspection({ run }: { run: DreamRun }) {
  return (
    <InspectionDetails
      label={t('homepage.card.inspectDreamRun', 'Inspect consolidation run')}
      meta={`${formatCount(run.sourceMemoryEntryIds.length, 'memory', 'memories')} / ${formatCount(run.candidateProposalIds.length, 'proposal', 'proposals')}`}
    >
      <FieldGrid
        items={[
          { label: t('homepage.card.model', 'Model'), value: run.modelId || t('homepage.card.unknownModel', 'Unknown') },
          { label: t('homepage.card.started', 'Started'), value: formatIso(run.startedAt) },
          { label: t('homepage.card.finished', 'Finished'), value: formatIso(run.finishedAt) },
          { label: t('homepage.card.instructionsHash', 'Instructions hash'), value: shortHash(run.instructionsHash) },
          { label: t('homepage.card.tokens', 'Tokens'), value: run.tokenUsage ? `${run.tokenUsage.input + run.tokenUsage.output + run.tokenUsage.reasoning}` : t('homepage.card.notRecorded', 'Not recorded') },
          { label: t('homepage.card.cost', 'Cost'), value: typeof run.costUsd === 'number' ? `$${run.costUsd.toFixed(4)}` : t('homepage.card.notRecorded', 'Not recorded') },
        ]}
      />
      <section>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.sourceMemory', 'Source memory')}</div>
        <TagList items={run.sourceMemoryEntryIds} emptyLabel={t('homepage.card.noSourceMemory', 'No source memory recorded.')} />
      </section>
      <section>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.sourceTraces', 'Source traces')}</div>
        <TagList items={run.sourceTraceEventIds} emptyLabel={t('homepage.card.noSourceTraces', 'No source traces recorded.')} />
      </section>
      <section>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.candidateProposals', 'Candidate proposals')}</div>
        <TagList items={run.candidateProposalIds} emptyLabel={t('homepage.card.noCandidateProposals', 'No candidate proposals produced.')} />
      </section>
    </InspectionDetails>
  )
}
