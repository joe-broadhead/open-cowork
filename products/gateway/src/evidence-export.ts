import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { getConfig, getConfigDir, type GatewayConfig } from './config.js'
import { redactSensitiveText } from './security.js'
import { buildEvidenceContract, buildEvidencePipelineV2, sanitizeEvidenceRefs, summarizeEvidenceContractState, type EvidenceContractEnvelope, type EvidenceContractStateSummary, type EvidencePipelineV2Report } from './evidence-contract.js'
import { buildTraceCorrelationIndex, countChannelFailureEvents, evaluateObservabilitySLOs, type ObservabilitySloResult } from './observability-contract.js'
import { replacePhoneLikeText, replacePrivateText, replaceProviderTargetText, replaceSessionIdText } from './operational-redaction.js'
import {
  appendWorkEvent,
  listChannelBindings,
  listProjectBindings,
  listWorkEvents,
  loadWorkState,
  workStatePath,
  type ChannelBindingRecord,
  type ProjectBindingRecord,
  type RoadmapRecord,
  type RunRecord,
  type WorkEventRecord,
  type WorkState,
  type WorkTaskRecord,
} from './work-store.js'
import { getRunArtifactManifestView } from './artifacts.js'

export type EvidenceExportMode = 'redacted' | 'unredacted'

const EVIDENCE_HASH_LENGTH = 12

export interface EvidenceExportTarget {
  taskId?: string
  runId?: string
  sessionId?: string
  roadmapId?: string
  projectId?: string
}

export interface EvidenceExportOptions {
  target?: EvidenceExportTarget
  mode?: EvidenceExportMode
  allowUnredacted?: boolean
  eventLimit?: number
  artifactPreviewBytes?: number
  now?: Date
  filePath?: string
  config?: GatewayConfig
  rootDir?: string
  stateDir?: string
}

export interface EvidenceExportArtifact {
  ref: string
  hash: string
  manifestId?: string
  artifactId?: string
  status?: string
  redactionStatus?: string
  retentionPolicy?: string
  contentType?: string
  sizeBytes?: number
  previewSafe?: boolean
  preview?: string
  previewBytes?: number
  omittedReason?: string
}

export interface EvidenceExportManifest {
  schemaVersion: 1
  id: string
  generatedAt: string
  mode: EvidenceExportMode
  target: EvidenceExportTarget
  redaction: {
    enabled: boolean
    rules: string[]
    unredactedRequires: string
  }
  evidenceContract: EvidenceContractEnvelope
  contractState: EvidenceContractStateSummary
  pipeline: EvidencePipelineV2Report
  counts: {
    roadmaps: number
    tasks: number
    runs: number
    sessions: number
    channelBindings: number
    projectBindings: number
    events: number
    artifacts: number
  }
  correlation: {
    traceRootId: string
    taskTraces: Array<{ taskId: string; traceId: string; runTraceIds: string[] }>
    runTraces: Array<{ runId: string; traceId: string; taskTraceId?: string; stage: string; status: string }>
    roadmapIds: string[]
    taskIds: string[]
    runIds: string[]
    sessionIds: Array<{ id: string; hash: string }>
    channelTargets: Array<{ provider: string; chatId: string; chatHash: string; threadId?: string; threadHash?: string; targetHash: string }>
  }
  slo: ObservabilitySloResult[]
  roadmaps: Array<Record<string, unknown>>
  tasks: Array<Record<string, unknown>>
  runs: Array<Record<string, unknown>>
  channelBindings: Array<Record<string, unknown>>
  projectBindings: Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
  artifacts: EvidenceExportArtifact[]
}

export interface EvidenceExportBundle {
  manifest: EvidenceExportManifest
  markdown: string
}

interface EvidenceRedactor {
  redactObject<T>(value: T): T
  redactText(value: string, key?: string): string
  mask(kind: string, value?: string): string | undefined
  hash(value?: string): string
  config: GatewayConfig
}

const TEXT_SECRET_KEY_PATTERN = /^(artifactPreview|body|content|description|feedback|message|note|prompt|raw|summary|text|transcript)$/i
const SECRET_KEY_PATTERN = /(authorization|token|secret|password|credential|privateKey|apiKey|api_key|api-key|signature)/i
const CHAT_ID_KEY_PATTERN = /(^|_)(chatId|chat_id|channelId|channel_id|targetId|target_id)$/i
const THREAD_ID_KEY_PATTERN = /(^|_)(threadId|thread_id|topicId|topic_id)$/i
const SESSION_ID_KEY_PATTERN = /(^|_)(sessionId|session_id|parentSessionId|parent_session_id)$/i
const USER_ID_KEY_PATTERN = /(^|_)(userId|user_id)$/i
const WEBHOOK_URL_KEY_PATTERN = /(webhookUrl|webhook_url|callbackUrl|callback_url|callback|webhook)/i
const SESSION_TEXT_KEY_PATTERN = /(sessionText|session_text|transcript|messages)/i
const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^\s"'`),;]+|\/var\/[^\s"'`),;]+|\/tmp\/[^\s"'`),;]+|\/private\/[^\s"'`),;]+)/g
const WEBHOOK_URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>]*webhooks?[^\s"'`<>]*/gi
const SIGNATURE_VALUE_PATTERN = /\b(?:sha256=)?[a-f0-9]{32,}\b/gi
const DEFAULT_ARTIFACT_PREVIEW_BYTES = 1200
const MAX_INLINE_STRING = 500

export function buildEvidenceBundle(options: EvidenceExportOptions = {}): EvidenceExportBundle {
  const mode = options.mode || 'redacted'
  if (mode === 'unredacted' && !options.allowUnredacted) {
    throw new Error('unredacted evidence export requires explicit local/admin intent')
  }
  const config = options.config || getConfig()
  const rootDir = path.resolve(options.rootDir || process.cwd())
  const stateDir = path.resolve(options.stateDir || process.env['OPENCODE_GATEWAY_STATE_DIR'] || getConfigDir())
  const state = loadWorkState(options.filePath)
  const events = listWorkEvents(normalizeEventLimit(options.eventLimit), options.filePath)
  const channelBindings = listChannelBindings({}, options.filePath)
  const projectBindings = listProjectBindings({}, options.filePath)
  const redactor = createEvidenceRedactor({ config, rootDir, stateDir, channelBindings, projectBindings, mode })
  const selected = selectEvidenceRecords(state, events, channelBindings, projectBindings, normalizeTarget(options.target))
  const generatedAt = (options.now || new Date()).toISOString()
  const trace = buildTraceCorrelationIndex({ state, events: selected.events, channelBindings: selected.channelBindings, generatedAt })
  const traceTasksById = new Map(trace.tasks.map(task => [task.taskId, task]))
  const traceRunsById = new Map(trace.runs.map(run => [run.runId, run]))
  const channelFailureCount = countChannelFailureEvents(selected.events)
  const slo = evaluateObservabilitySLOs({ state, events: selected.events, channelFailureCount, now: Date.parse(generatedAt) })
  const artifacts = selected.runs.flatMap(run => artifactRefsForRun(run))
  const artifactContext = buildArtifactExportContext(selected.runs, state, options.filePath || workStatePath())
  const artifactPreviews = artifacts.map(ref => exportArtifact(ref, redactor, {
    rootDir,
    stateDir,
    previewBytes: options.artifactPreviewBytes ?? DEFAULT_ARTIFACT_PREVIEW_BYTES,
  }, artifactContext.get(hashText(ref))))
  const bundleFingerprint = evidenceBundleFingerprint({
    mode,
    target: selected.target,
    generatedAt,
    roadmapIds: selected.roadmaps.map(roadmap => roadmap.id),
    taskIds: selected.tasks.map(task => task.id),
    runIds: selected.runs.map(run => run.id),
    sessionIds: selected.sessionIds,
    eventIds: selected.events.map(event => event.id),
    artifactHashes: artifactPreviews.map(artifact => artifact.hash),
  })
  const redactionRules = [
    'configured secrets and bearer tokens',
    'channel chat IDs',
    'channel thread/topic IDs',
    'phone-like provider target IDs',
    'private transcript/message bodies',
    'webhook URLs and signatures',
    'user-identifying IDs',
    'absolute paths outside the repository or Gateway state directory',
    'large artifact previews',
  ]
  const evidenceContract = buildEvidenceContract({
    generatedAt,
    claim: {
      state: mode === 'redacted' ? 'local_beta_evidence_only' : 'local_admin_unredacted_only',
      effect: 'local_evidence_integrity_only',
      publicClaim: mode === 'redacted' ? 'Redacted local public-beta evidence only.' : 'Unredacted local-admin evidence only; not share-safe.',
      boundary: 'No release-claim expansion from this evidence export.',
      unsupportedClaims: [
        'production-certified evidence',
        'release-candidate approval',
        'hosted/team readiness',
        'WhatsApp live readiness',
        'universal-channel readiness',
        'arbitrary-scale readiness',
      ],
    },
    redaction: {
      state: mode === 'redacted' ? 'redacted' : 'unredacted_local_admin_only',
      safeToShare: mode === 'redacted',
      rules: redactionRules,
      safeNextAction: mode === 'redacted'
        ? 'Share only the generated redacted manifest/markdown; regenerate if any contract validation failure appears.'
        : 'Do not share this local-admin export; regenerate in redacted mode before review or publication.',
    },
    proof: {
      state: mode === 'redacted' ? 'supported_bounded' : 'blocked',
      mode: 'local_state',
      summary: mode === 'redacted'
        ? 'Redacted local evidence bundle generated from current Gateway state.'
        : 'Unredacted local-admin export is blocked for sharing.',
      safeNextAction: mode === 'redacted'
        ? 'Use this bundle only inside the stated local-beta evidence boundary.'
        : 'Regenerate in redacted mode before sharing, review, or publication.',
      evidenceRefs: [
        `trace:${trace.traceRootId}`,
        'manifest:redaction.rules',
      ],
    },
    evidenceRefs: sanitizeEvidenceRefs([
      `trace:${trace.traceRootId}`,
      'manifest:redaction.rules',
      ...selected.roadmaps.map(roadmap => `roadmap:${roadmap.id}`),
      ...selected.tasks.map(task => `task:${task.id}`),
      ...selected.runs.map(run => `run:${run.id}`),
      ...selected.sessionIds.map(id => `session:${redactor.hash(id)}`),
      ...selected.events.map(event => `event:${event.id}`),
      ...artifactPreviews.map(artifact => `artifact:${artifact.hash}`),
    ]),
    residualRisks: mode === 'redacted'
      ? []
      : [{
          id: 'unredacted_local_admin_export',
          state: 'open',
          summary: 'The export intentionally includes unredacted local-admin evidence.',
          safeNextAction: 'Regenerate in redacted mode before sharing, review, or publication.',
      }],
  })
  const pipeline = buildEvidencePipelineV2({
    surface: 'evidence_export',
    contracts: [evidenceContract],
    generatedAt,
    decision: {
      state: mode === 'redacted' ? 'no_decision' : 'decision_blocked',
      claimChange: mode === 'redacted' ? 'no_release_claim_expansion' : 'blocked',
      claimEffect: 'local_evidence_integrity_only',
      summary: mode === 'redacted'
        ? 'Redacted evidence export is local beta evidence only with no release-claim expansion.'
        : 'Unredacted local-admin evidence export is blocked for sharing and decision use.',
      safeNextAction: mode === 'redacted'
        ? 'Use this export only inside the stated local-beta evidence boundary.'
        : 'Regenerate in redacted mode before sharing, review, or publication.',
      evidenceRefs: [`trace:${trace.traceRootId}`, `evidence-export:${bundleFingerprint}`],
    },
  })
  const manifest: EvidenceExportManifest = {
    schemaVersion: 1,
    id: `evidence_${timestampId(generatedAt)}_${bundleFingerprint}`,
    generatedAt,
    mode,
    target: selected.target,
    redaction: {
      enabled: mode === 'redacted',
      rules: redactionRules,
      unredactedRequires: '--unredacted --local-admin or HTTP admin capability plus localAdmin=true',
    },
    evidenceContract,
    contractState: summarizeEvidenceContractState(evidenceContract),
    pipeline,
    counts: {
      roadmaps: selected.roadmaps.length,
      tasks: selected.tasks.length,
      runs: selected.runs.length,
      sessions: selected.sessionIds.length,
      channelBindings: selected.channelBindings.length,
      projectBindings: selected.projectBindings.length,
      events: selected.events.length,
      artifacts: artifactPreviews.length,
    },
    correlation: {
      traceRootId: trace.traceRootId,
      taskTraces: selected.tasks.map(task => traceTasksById.get(task.id)).filter(Boolean).map(task => ({ taskId: task!.taskId, traceId: task!.traceId, runTraceIds: task!.runTraceIds })),
      runTraces: selected.runs.map(run => traceRunsById.get(run.id)).filter(Boolean).map(run => ({ runId: run!.runId, traceId: run!.traceId, taskTraceId: run!.taskTraceId, stage: run!.stage, status: run!.status })),
      roadmapIds: selected.roadmaps.map(roadmap => roadmap.id),
      taskIds: selected.tasks.map(task => task.id),
      runIds: selected.runs.map(run => run.id),
      sessionIds: selected.sessionIds.map(id => ({ id: redactor.mask('session', id)!, hash: redactor.hash(id) })),
      channelTargets: selected.channelBindings.map(binding => ({
        provider: binding.provider,
        chatId: redactor.mask(`${binding.provider}.chat`, binding.chatId)!,
        chatHash: redactor.hash(`${binding.provider}:${binding.chatId}`),
        threadId: binding.threadId ? redactor.mask(`${binding.provider}.thread`, binding.threadId) : undefined,
        threadHash: binding.threadId ? redactor.hash(`${binding.provider}:${binding.threadId}`) : undefined,
        targetHash: redactor.hash(`${binding.provider}:${binding.chatId}:${binding.threadId || ''}`),
      })),
    },
    slo,
    roadmaps: selected.roadmaps.map(roadmap => redactor.redactObject(compactRoadmapEvidence(roadmap))),
    tasks: selected.tasks.map(task => redactor.redactObject(compactTaskEvidence(task))),
    runs: selected.runs.map(run => redactor.redactObject(compactRunEvidence(run))),
    channelBindings: selected.channelBindings.map(binding => redactor.redactObject(compactChannelBindingEvidence(binding))),
    projectBindings: selected.projectBindings.map(binding => redactor.redactObject(compactProjectBindingEvidence(binding))),
    events: selected.events.map(event => redactor.redactObject(compactEventEvidence(event))),
    artifacts: artifactPreviews,
  }
  return { manifest, markdown: formatEvidenceBundleMarkdown(manifest) }
}

export function writeEvidenceBundle(bundle: EvidenceExportBundle, outputDir: string): { directory: string; manifestPath: string; markdownPath: string } {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const manifestPath = path.join(outputDir, 'manifest.json')
  const markdownPath = path.join(outputDir, 'evidence.md')
  fs.writeFileSync(manifestPath, JSON.stringify(bundle.manifest, null, 2) + '\n', { mode: 0o600 })
  fs.writeFileSync(markdownPath, bundle.markdown, { mode: 0o600 })
  const written = { directory: outputDir, manifestPath, markdownPath }
  appendEvidenceExportAuditEvent(bundle, written)
  return written
}

export function defaultEvidenceBundleDir(bundleId: string): string {
  return path.join(process.env['OPENCODE_GATEWAY_STATE_DIR'] || getConfigDir(), 'evidence-bundles', bundleId)
}

export function formatEvidenceBundleMarkdown(manifest: EvidenceExportManifest): string {
  const lines = [
    '# Redacted Evidence Bundle',
    '',
    `- Bundle: \`${manifest.id}\``,
    `- Generated: ${manifest.generatedAt}`,
    `- Mode: ${manifest.mode}`,
    `- Target: ${formatTarget(manifest.target)}`,
    `- Redaction: ${manifest.redaction.enabled ? 'enabled' : 'disabled by explicit local/admin intent'}`,
    `- Evidence contract: ${manifest.evidenceContract.validation.state} (${manifest.evidenceContract.claim.effect})`,
    `- Evidence pipeline: ${manifest.pipeline.status} (${manifest.pipeline.decision.claimChange})`,
    `- Proof state: ${manifest.contractState.proofState} (${manifest.contractState.proofMode})`,
    '',
    '## Counts',
    '',
    `- Roadmaps: ${manifest.counts.roadmaps}`,
    `- Tasks: ${manifest.counts.tasks}`,
    `- Runs: ${manifest.counts.runs}`,
    `- Sessions: ${manifest.counts.sessions}`,
    `- Channel bindings: ${manifest.counts.channelBindings}`,
    `- Project bindings: ${manifest.counts.projectBindings}`,
    `- Events: ${manifest.counts.events}`,
    `- Artifacts: ${manifest.counts.artifacts}`,
    '',
    '## Correlation',
    '',
    `- Trace root: ${manifest.correlation.traceRootId}`,
    `- Roadmaps: ${manifest.correlation.roadmapIds.join(', ') || 'none'}`,
    `- Tasks: ${manifest.correlation.taskIds.join(', ') || 'none'}`,
    `- Runs: ${manifest.correlation.runIds.join(', ') || 'none'}`,
    `- Task traces: ${manifest.correlation.taskTraces.map(row => `${row.taskId}=${row.traceId}`).join(', ') || 'none'}`,
    `- Run traces: ${manifest.correlation.runTraces.map(row => `${row.runId}=${row.traceId}`).join(', ') || 'none'}`,
    `- Sessions: ${manifest.correlation.sessionIds.map(row => `${row.id} (${row.hash})`).join(', ') || 'none'}`,
    `- Channel targets: ${manifest.correlation.channelTargets.map(row => `${row.provider}:${row.chatId}${row.threadId ? `:${row.threadId}` : ''} (${row.targetHash})`).join(', ') || 'none'}`,
    '',
    '## SLOs',
    '',
    ...manifest.slo.map(row => `- [${row.status}] ${row.label}: ${row.summary}`),
    '',
    '## Runs',
    '',
    ...formatTable(manifest.runs, ['id', 'taskId', 'stage', 'status', 'sessionId', 'profile', 'completedAt']),
    '',
    '## Events',
    '',
    ...manifest.events.slice(0, 25).map(event => `- ${event['id']}: ${event['type']} subject=${event['subjectId'] || 'none'} hash=${event['payloadHash']}`),
    '',
    '## Artifacts',
    '',
    ...manifest.artifacts.map(artifact => `- ${artifact.ref} hash=${artifact.hash}${artifact.preview ? ` preview=${JSON.stringify(artifact.preview)}` : artifact.omittedReason ? ` omitted=${artifact.omittedReason}` : ''}`),
    '',
    '## Redaction Rules',
    '',
    ...manifest.redaction.rules.map(rule => `- ${rule}`),
    '',
  ]
  return lines.join('\n')
}

function appendEvidenceExportAuditEvent(bundle: EvidenceExportBundle, written: { directory: string; manifestPath: string; markdownPath: string }): void {
  try {
    appendWorkEvent('evidence.export.written', bundle.manifest.id, {
      bundleId: bundle.manifest.id,
      mode: bundle.manifest.mode,
      target: {
        keys: Object.keys(bundle.manifest.target).filter(key => Boolean(bundle.manifest.target[key as keyof EvidenceExportTarget])),
        hash: hashText(JSON.stringify(bundle.manifest.target)),
      },
      refs: {
        directory: evidencePathRef(written.directory),
        manifest: evidencePathRef(written.manifestPath),
        markdown: evidencePathRef(written.markdownPath),
      },
    })
  } catch {
    // Evidence export must not fail just because the audit ledger is temporarily unavailable.
  }
}

function evidencePathRef(value: string): string {
  const resolved = path.resolve(value)
  const stateDir = path.resolve(process.env['OPENCODE_GATEWAY_STATE_DIR'] || getConfigDir())
  const rootDir = path.resolve(process.cwd())
  if (isChildPath(stateDir, resolved)) return `<state>/${path.relative(stateDir, resolved)}`
  if (isChildPath(rootDir, resolved)) return `<repo>/${path.relative(rootDir, resolved)}`
  return `<redacted:path:${hashText(resolved)}>`
}

function createEvidenceRedactor(input: {
  config: GatewayConfig
  rootDir: string
  stateDir: string
  channelBindings: ChannelBindingRecord[]
  projectBindings: ProjectBindingRecord[]
  mode: EvidenceExportMode
}): EvidenceRedactor {
  const rawIds = new Set<string>()
  for (const binding of [...input.channelBindings, ...input.projectBindings]) {
    if (binding.chatId) rawIds.add(binding.chatId)
    if (binding.threadId) rawIds.add(binding.threadId)
  }
  const redactor: EvidenceRedactor = {
    config: input.config,
    hash(value?: string) {
      return hashText(value || '')
    },
    mask(kind: string, value?: string) {
      if (!value) return undefined
      if (input.mode === 'unredacted') return value
      if (value.startsWith('<redacted:')) return value
      return `<redacted:${kind}:${hashText(value)}>`
    },
    redactText(value: string, key = '') {
      if (input.mode === 'unredacted') return value
      let text = redactSensitiveText(String(value || ''), input.config)
      for (const raw of rawIds) {
        if (!raw) continue
        text = text.split(raw).join(`<redacted:id:${hashText(raw)}>`)
      }
      text = redactProviderTargets(text)
      text = redactSessionIds(text)
      text = redactPrivateText(text)
      text = redactPhoneLikeTargets(text)
      text = redactWebhookUrls(text)
      text = redactSignatureValues(text, key)
      text = redactAbsolutePaths(text, input.rootDir, input.stateDir)
      if (TEXT_SECRET_KEY_PATTERN.test(key) || SESSION_TEXT_KEY_PATTERN.test(key)) {
        return `<redacted:text:${hashText(text)}:${text.length} chars>`
      }
      return truncate(text, MAX_INLINE_STRING)
    },
    redactObject<T>(value: T): T {
      return redactEvidenceValue(value, redactor) as T
    },
  }
  return redactor
}

function redactEvidenceValue(value: unknown, redactor: EvidenceRedactor, key = ''): unknown {
  if (Array.isArray(value)) return value.map(item => redactEvidenceValue(item, redactor, key))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(childKey)) {
        output[childKey] = child ? '<redacted:secret>' : child
      } else if (CHAT_ID_KEY_PATTERN.test(childKey)) {
        output[childKey] = redactor.mask('chat', String(child || ''))
      } else if (THREAD_ID_KEY_PATTERN.test(childKey)) {
        output[childKey] = child ? redactor.mask('thread', String(child)) : child
      } else if (SESSION_ID_KEY_PATTERN.test(childKey)) {
        output[childKey] = child ? redactor.mask('session', String(child)) : child
      } else if (/^subjectId$/i.test(childKey) && typeof child === 'string' && /^ses[_A-Za-z0-9-]+/.test(child)) {
        output[childKey] = redactor.mask('session', child)
      } else if (USER_ID_KEY_PATTERN.test(childKey)) {
        output[childKey] = child ? redactor.mask('user', String(child)) : child
      } else if (WEBHOOK_URL_KEY_PATTERN.test(childKey) && typeof child === 'string' && /^https?:\/\//i.test(child)) {
        output[childKey] = redactor.mask('webhook_url', child)
      } else {
        output[childKey] = redactEvidenceValue(child, redactor, childKey)
      }
    }
    return output
  }
  if (typeof value === 'string') return redactor.redactText(value, key)
  return value
}

function selectEvidenceRecords(
  state: WorkState,
  events: WorkEventRecord[],
  channelBindings: ChannelBindingRecord[],
  projectBindings: ProjectBindingRecord[],
  rawTarget: EvidenceExportTarget,
) {
  const target = normalizeTarget(rawTarget)
  const runMatches = new Set<string>()
  const taskMatches = new Set<string>()
  const roadmapMatches = new Set<string>()
  const sessionMatches = new Set<string>()
  if (target.runId) runMatches.add(target.runId)
  if (target.taskId) taskMatches.add(target.taskId)
  if (target.roadmapId) roadmapMatches.add(target.roadmapId)
  if (target.projectId) roadmapMatches.add(target.projectId)
  if (target.sessionId) sessionMatches.add(target.sessionId)

  for (const run of state.runs) {
    if (runMatches.has(run.id) || sessionMatches.has(run.sessionId)) {
      taskMatches.add(run.taskId)
      sessionMatches.add(run.sessionId)
    }
  }
  for (const task of state.tasks) {
    if (taskMatches.has(task.id) || roadmapMatches.has(task.roadmapId)) {
      taskMatches.add(task.id)
      roadmapMatches.add(task.roadmapId)
    }
  }
  for (const binding of channelBindings) {
    if (sessionMatches.has(binding.sessionId) || (binding.taskId && taskMatches.has(binding.taskId)) || (binding.roadmapId && roadmapMatches.has(binding.roadmapId))) {
      sessionMatches.add(binding.sessionId)
      if (binding.taskId) taskMatches.add(binding.taskId)
      if (binding.roadmapId) roadmapMatches.add(binding.roadmapId)
    }
  }
  for (const binding of projectBindings) {
    if (sessionMatches.has(binding.sessionId) || roadmapMatches.has(binding.roadmapId)) {
      sessionMatches.add(binding.sessionId)
      roadmapMatches.add(binding.roadmapId)
    }
  }

  const hasTarget = Boolean(target.taskId || target.runId || target.sessionId || target.roadmapId || target.projectId)
  const roadmaps = state.roadmaps.filter(roadmap => !hasTarget || roadmapMatches.has(roadmap.id))
  const tasks = state.tasks.filter(task => !hasTarget || taskMatches.has(task.id) || roadmapMatches.has(task.roadmapId)).slice(-50)
  const runs = state.runs.filter(run => !hasTarget || runMatches.has(run.id) || taskMatches.has(run.taskId) || sessionMatches.has(run.sessionId)).slice(-50)
  for (const run of runs) sessionMatches.add(run.sessionId)
  const selectedSessionIds = new Set([...sessionMatches, ...runs.map(run => run.sessionId)])
  const selectedTaskIds = new Set([...taskMatches, ...tasks.map(task => task.id), ...runs.map(run => run.taskId)])
  const selectedRoadmapIds = new Set([...roadmapMatches, ...tasks.map(task => task.roadmapId)])
  const selectedRunIds = new Set(runs.map(run => run.id))
  const selectedChannelBindings = channelBindings.filter(binding =>
    !hasTarget ||
    selectedSessionIds.has(binding.sessionId) ||
    (binding.taskId ? selectedTaskIds.has(binding.taskId) : false) ||
    (binding.roadmapId ? selectedRoadmapIds.has(binding.roadmapId) : false)
  )
  const selectedProjectBindings = projectBindings.filter(binding => !hasTarget || selectedSessionIds.has(binding.sessionId) || selectedRoadmapIds.has(binding.roadmapId))
  const selectedEvents = events.filter(event => {
    if (!hasTarget) return true
    if (event.subjectId && (selectedTaskIds.has(event.subjectId) || selectedRunIds.has(event.subjectId) || selectedSessionIds.has(event.subjectId) || selectedRoadmapIds.has(event.subjectId))) return true
    const text = JSON.stringify(event.payload || {})
    return [...selectedTaskIds, ...selectedRunIds, ...selectedSessionIds, ...selectedRoadmapIds].some(id => id && text.includes(id))
  }).slice(-100)

  return {
    target,
    roadmaps,
    tasks,
    runs,
    sessionIds: [...selectedSessionIds].sort(),
    channelBindings: selectedChannelBindings,
    projectBindings: selectedProjectBindings,
    events: selectedEvents,
  }
}

function compactRoadmapEvidence(roadmap: RoadmapRecord): Record<string, unknown> {
  return { id: roadmap.id, title: roadmap.title, status: roadmap.status, priority: roadmap.priority, agentTeam: roadmap.agentTeam, qualitySpec: roadmap.qualitySpec, createdAt: roadmap.createdAt, updatedAt: roadmap.updatedAt }
}

function compactTaskEvidence(task: WorkTaskRecord): Record<string, unknown> {
  return { id: task.id, roadmapId: task.roadmapId, title: task.title, description: task.description, status: task.status, priority: task.priority, pipeline: task.pipeline, currentStage: task.currentStage, currentRunId: task.currentRunId, agent: task.agent, agentTeam: task.agentTeam, qualitySpec: task.qualitySpec, createdAt: task.createdAt, updatedAt: task.updatedAt }
}

function compactRunEvidence(run: RunRecord): Record<string, unknown> {
  return { id: run.id, taskId: run.taskId, stage: run.stage, sessionId: run.sessionId, profile: run.profile, resolvedProfile: run.resolvedProfile, resolvedAgent: run.resolvedAgent, status: run.status, attempt: run.attempt, startedAt: run.startedAt, completedAt: run.completedAt, runtimeMs: run.runtimeMs, costUsd: run.costUsd, result: run.result, environment: run.environment }
}

function compactChannelBindingEvidence(binding: ChannelBindingRecord): Record<string, unknown> {
  return { provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId, sessionId: binding.sessionId, mode: binding.mode, roadmapId: binding.roadmapId, taskId: binding.taskId, title: binding.title, createdAt: binding.createdAt, updatedAt: binding.updatedAt }
}

function compactProjectBindingEvidence(binding: ProjectBindingRecord): Record<string, unknown> {
  return { id: binding.id, alias: binding.alias, roadmapId: binding.roadmapId, sessionId: binding.sessionId, scope: binding.scope, provider: binding.provider, chatId: binding.chatId, threadId: binding.threadId, title: binding.title, notificationMode: binding.notificationMode, createdAt: binding.createdAt, updatedAt: binding.updatedAt }
}

function compactEventEvidence(event: WorkEventRecord): Record<string, unknown> {
  return { id: event.id, type: event.type, subjectId: event.subjectId, payloadHash: hashText(JSON.stringify(event.payload || {})), payload: event.payload, createdAt: event.createdAt, processedAt: event.processedAt }
}

function artifactRefsForRun(run: RunRecord): string[] {
  const refs = [
    ...(run.result?.artifacts || []),
    ...((run.result?.evidence || []).map(item => item.ref).filter(Boolean) as string[]),
  ]
  return [...new Set(refs.map(ref => String(ref).trim()).filter(Boolean))]
}

function exportArtifact(ref: string, redactor: EvidenceRedactor, options: { rootDir: string; stateDir: string; previewBytes: number }, context?: ArtifactExportContext): EvidenceExportArtifact {
  const base = {
    ref: redactor.redactText(ref, 'artifactRef'),
    hash: hashText(ref),
    manifestId: context?.manifestId,
    artifactId: context?.artifactId,
    status: context?.status,
    redactionStatus: context?.redactionStatus,
    retentionPolicy: context?.retentionPolicy,
    contentType: context?.contentType,
    sizeBytes: context?.sizeBytes,
    previewSafe: context?.previewSafe,
  }
  const filePath = artifactFilePath(ref)
  if (!filePath) return { ...base, omittedReason: context?.omittedReason }
  const resolved = path.resolve(filePath)
  if (!isChildPath(options.rootDir, resolved) && !isChildPath(options.stateDir, resolved)) {
    return { ...base, omittedReason: context?.omittedReason || 'file path outside repository/state directory' }
  }
  if (!fs.existsSync(resolved)) return { ...base, omittedReason: context?.omittedReason || 'file not found' }
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) return { ...base, omittedReason: context?.omittedReason || 'artifact is not a file' }
  if (context?.previewSafe === false) return { ...base, omittedReason: context.omittedReason || 'artifact preview blocked by manifest policy' }
  const preview = fs.readFileSync(resolved, 'utf-8').slice(0, options.previewBytes)
  return { ...base, preview: redactor.redactText(preview, 'artifactPreview'), previewBytes: Math.min(stat.size, options.previewBytes) }
}

interface ArtifactExportContext {
  manifestId: string
  artifactId: string
  status: string
  redactionStatus: string
  retentionPolicy: string
  contentType: string
  sizeBytes?: number
  previewSafe: boolean
  omittedReason?: string
}

function buildArtifactExportContext(runs: RunRecord[], state: WorkState, stateFilePath: string): Map<string, ArtifactExportContext> {
  const byRefHash = new Map<string, ArtifactExportContext>()
  for (const run of runs) {
    const manifest = getRunArtifactManifestView(run.id, state, stateFilePath)
    if (!manifest) continue
    for (const entry of manifest.entries) {
      // Evidence exports use shorter stable hashes than manifests; join on the shared prefix.
      byRefHash.set(entry.refHash.slice(0, EVIDENCE_HASH_LENGTH), {
        manifestId: manifest.id,
        artifactId: entry.id,
        status: entry.status,
        redactionStatus: entry.redactionStatus,
        retentionPolicy: entry.retentionPolicy,
        contentType: entry.contentType,
        sizeBytes: entry.sizeBytes,
        previewSafe: entry.previewSafe,
        omittedReason: entry.omittedReason,
      })
    }
  }
  return byRefHash
}

function artifactFilePath(ref: string): string | undefined {
  if (ref.startsWith('file:')) return ref.slice('file:'.length)
  if (ref.startsWith('/') || ref.startsWith('./') || ref.startsWith('../')) return ref
  return undefined
}

function normalizeTarget(target: EvidenceExportTarget | undefined): EvidenceExportTarget {
  return {
    taskId: cleanString(target?.taskId),
    runId: cleanString(target?.runId),
    sessionId: cleanString(target?.sessionId),
    roadmapId: cleanString(target?.roadmapId),
    projectId: cleanString(target?.projectId),
  }
}

function cleanString(value: unknown): string | undefined {
  const text = String(value || '').trim()
  return text || undefined
}

function normalizeEventLimit(value: unknown): number {
  const limit = Number(value || 250)
  return Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 250))
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, EVIDENCE_HASH_LENGTH)
}

function timestampId(value: string): string {
  return value.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function evidenceBundleFingerprint(value: Record<string, unknown>): string {
  return hashText(JSON.stringify(value))
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...<truncated:${value.length - max} chars>`
}

function redactAbsolutePaths(value: string, rootDir: string, stateDir: string): string {
  return value.replace(ABSOLUTE_PATH_PATTERN, match => {
    const resolved = path.resolve(match)
    if (isChildPath(rootDir, resolved)) return `<repo>/${path.relative(rootDir, resolved)}`
    if (isChildPath(stateDir, resolved)) return `<state>/${path.relative(stateDir, resolved)}`
    return `<redacted:path:${hashText(resolved)}>`
  })
}

function redactProviderTargets(value: string): string {
  return replaceProviderTargetText(value, ({ provider, chatId, threadId }) => {
    const targetHash = hashText(`${provider}:${chatId}:${threadId || ''}`)
    const thread = threadId ? `:<redacted:${provider}.thread:${hashText(`${provider}:${threadId}`)}>` : ''
    return `${provider}:<redacted:${provider}.chat:${hashText(`${provider}:${chatId}`)}>${thread} (${targetHash})`
  })
}

function redactSessionIds(value: string): string {
  return replaceSessionIdText(value, match => `<redacted:session:${hashText(match)}>`)
}

function redactPhoneLikeTargets(value: string): string {
  return replacePhoneLikeText(value, match => `<redacted:phone:${hashText(match.replace(/\D/g, ''))}>`)
}

function redactPrivateText(value: string): string {
  return replacePrivateText(value, match => `<redacted:private-text:${hashText(match)}>`)
}

function redactWebhookUrls(value: string): string {
  return value.replace(WEBHOOK_URL_PATTERN, match => `<redacted:webhook_url:${hashText(match)}>`)
}

function redactSignatureValues(value: string, key: string): string {
  if (!/signature|x-hub|x-signature/i.test(key) && !/\bsha256=/.test(value)) return value
  return value.replace(SIGNATURE_VALUE_PATTERN, match => `<redacted:signature:${hashText(match)}>`)
}

function isChildPath(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function formatTarget(target: EvidenceExportTarget): string {
  const entries = Object.entries(target).filter((entry): entry is [string, string] => Boolean(entry[1]))
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(', ') : 'recent gateway evidence'
}

function formatTable(rows: Array<Record<string, unknown>>, keys: string[]): string[] {
  if (!rows.length) return ['No rows.']
  const header = `| ${keys.join(' | ')} |`
  const separator = `| ${keys.map(() => '---').join(' | ')} |`
  const body = rows.slice(0, 20).map(row => `| ${keys.map(key => markdownCell(row[key])).join(' | ')} |`)
  return [header, separator, ...body]
}

function markdownCell(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
