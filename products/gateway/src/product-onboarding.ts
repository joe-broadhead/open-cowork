import * as fs from 'node:fs'
import * as path from 'node:path'
import { getConfig, type GatewayConfig } from './config.js'
import { redactSensitiveText } from './security.js'
import { storageStateDir } from './storage.js'
import { createSupervisedProject, loadWorkState, startWorkTaskRun, completeWorkTaskRun, appendWorkEvent, workStatePath, type RoadmapRecord, type RoadmapQualitySpec, type WorkState, type WorkTaskRecord } from './work-store.js'
import { runReferencesArtifact } from './work-store/queries.js'
import type { StageEvidence } from './workflow.js'
import { normalizePriority } from './work-store/validators.js'

export const ENVIRONMENT_TEMPLATE_KINDS = ['node', 'python', 'rust', 'docs', 'container', 'crabbox', 'generic'] as const
export type EnvironmentTemplateKind = typeof ENVIRONMENT_TEMPLATE_KINDS[number]

export interface TemplateWriteResult {
  kind: EnvironmentTemplateKind
  path: string
  created: boolean
  content: string
}

export interface RunExplanation {
  severity: 'info' | 'warning' | 'critical'
  title: string
  summary: string
  actions: string[]
  taskId?: string
}

export interface ProjectWizardInput {
  alias: string
  title?: string
  priority?: 'HIGH' | 'MEDIUM' | 'LOW'
  sessionId?: string
  scope?: 'global' | 'opencode' | 'telegram' | 'whatsapp' | 'discord'
  profile?: string
  notificationMode?: 'immediate' | 'digest' | 'muted'
  environment?: string | Record<string, unknown>
  agentTeam?: string
  tasks?: Array<string | { title: string; description?: string; priority?: 'HIGH' | 'MEDIUM' | 'LOW' }>
  objective?: string
  acceptanceCriteria?: string[]
  definitionOfDone?: string[]
  evidenceRequirements?: string[]
  requiredArtifacts?: string[]
  residualRiskNotes?: string[]
  idempotencyKey?: string
  sourceType?: string
}

export interface ProjectWizardResult {
  roadmap: RoadmapRecord
  tasks: WorkTaskRecord[]
  supervisor?: unknown
  binding?: unknown
  text: string
}

export interface ProjectWizardBody extends Omit<ProjectWizardInput, 'tasks' | 'priority' | 'title'> {
  title: string
  priority: 'HIGH' | 'MEDIUM' | 'LOW'
  qualitySpec: RoadmapQualitySpec
  tasks: Array<Record<string, unknown>>
}

export interface DemoProjectResult extends ProjectWizardResult {
  artifactPath: string
  dashboardUrl: string
}

export interface ArtifactLink {
  ref: string
  label: string
  url: string
  downloadUrl: string
}

export interface ArtifactContent {
  ref: string
  path: string
  filename: string
  contentType: string
  content: string
}

export function buildEnvironmentTemplate(kind: EnvironmentTemplateKind): string {
  assertTemplateKind(kind)
  const templates: Record<EnvironmentTemplateKind, string> = {
    node: `# Gateway repository environment template for Node.js projects.
defaultEnvironment: node-local
environments:
  node-local:
    extends: local-process
    tools:
      - node
      - npm
    setup:
      - npm ci
    validation:
      - npm test
    resources:
      timeout: 45m
    network:
      mode: restricted
`,
    python: `# Gateway repository environment template for Python projects.
defaultEnvironment: python-local
environments:
  python-local:
    extends: local-process
    tools:
      - python
      - uv
    setup:
      - uv sync
    validation:
      - uv run pytest
    resources:
      timeout: 45m
    network:
      mode: restricted
`,
    rust: `# Gateway repository environment template for Rust projects.
defaultEnvironment: rust-local
environments:
  rust-local:
    extends: local-process
    tools:
      - rust
      - cargo
    validation:
      - cargo test --locked
    resources:
      timeout: 60m
    network:
      mode: restricted
`,
    docs: `# Gateway repository environment template for documentation projects.
defaultEnvironment: docs-local
environments:
  docs-local:
    extends: local-process
    tools:
      - python
      - uv
      - mkdocs
    validation:
      - uv run --with-requirements docs/requirements.txt mkdocs build --strict
    resources:
      timeout: 30m
    network:
      mode: restricted
`,
    container: `# Gateway repository environment template for Docker-compatible local containers.
# An administrator must define and approve the local-container base, including
# its Docker-compatible runtime executable. Repository config cannot replace it.
defaultEnvironment: local-container
environments:
  local-container:
    extends: local-container
    tools:
      - node
      - npm
    setup:
      - npm ci
    validation:
      - npm test
    container:
      image: node:22-bookworm
      workdir: /workspace
      pull: missing
      warm: true
    resources:
      timeout: 90m
    network:
      mode: restricted
    cleanup:
      retainOnFailure: true
`,
    crabbox: `# Gateway repository environment template for remote Crabbox capacity.
# An administrator must define and approve the remote-crabbox base and CLI.
defaultEnvironment: remote-crabbox
environments:
  remote-crabbox:
    extends: remote-crabbox
    tools:
      - node
      - npm
    validation:
      - npm test
    crabbox:
      profile: default
      class: standard
      ttl: 2h
      warm: true
      keepOnFailure: true
    resources:
      timeout: 2h
    network:
      mode: restricted
`,
    generic: `# Gateway repository environment template for generic local work.
defaultEnvironment: local-process
environments:
  local-process:
    extends: local-process
    tools:
      - git
    resources:
      timeout: 45m
    network:
      mode: restricted
`,
  }
  return templates[kind]
}

export function writeEnvironmentTemplate(kind: EnvironmentTemplateKind, directory: string, options: { force?: boolean } = {}): TemplateWriteResult {
  assertTemplateKind(kind)
  const targetDir = path.resolve(directory || process.cwd(), '.gateway')
  const target = path.join(targetDir, 'env.yaml')
  const content = buildEnvironmentTemplate(kind)
  if (fs.existsSync(target) && !options.force) return { kind, path: target, created: false, content: fs.readFileSync(target, 'utf-8') }
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(target, content, { mode: 0o644 })
  return { kind, path: target, created: true, content }
}

export function buildProjectWizardBody(input: ProjectWizardInput): ProjectWizardBody {
  const alias = normalizeAlias(input.alias)
  const title = String(input.title || alias).trim()
  const priority = normalizePriority(input.priority)
  const qualitySpec = buildRoadmapQualitySpec({ ...input, title })
  const tasks = normalizeWizardTasks(input.tasks, priority, input.environment, input.agentTeam)
  return {
    ...input,
    alias,
    title,
    priority,
    profile: input.profile || 'supervisor',
    notificationMode: input.notificationMode || 'immediate',
    qualitySpec,
    tasks,
  }
}

export function createProjectFromWizard(input: ProjectWizardInput): ProjectWizardResult {
  const body = buildProjectWizardBody(input)
  if (!body.sessionId) throw new Error('sessionId is required when creating a project without the daemon OpenCode client')
  const result = createSupervisedProject({
    roadmap: { title: body.title, priority: body.priority, agentTeam: body.agentTeam, environment: body.environment as any, qualitySpec: body.qualitySpec },
    tasks: body.tasks as any,
    supervisor: { sessionId: body.sessionId, profile: body.profile, isDefault: true, cadence: { intervalMs: 30 * 60 * 1000 }, eventTriggers: { taskCompleted: true, gateOpened: true }, completionPolicy: { mode: body.qualitySpec.completionPolicy }, note: 'Created by the Gateway project wizard.' },
    binding: { alias: body.alias, sessionId: body.sessionId, scope: body.scope || 'global', title: body.title, notificationMode: body.notificationMode },
    event: { type: 'project.wizard.created', payload: { alias: body.alias, sessionId: body.sessionId, idempotencyKey: body.idempotencyKey, sourceType: body.sourceType } },
  })
  return { roadmap: result.roadmap, tasks: result.tasks, supervisor: result.supervisor, binding: result.binding, text: projectWizardText(body.alias, result.roadmap, result.tasks) }
}

export function createDemoProject(options: { stateDir?: string; dashboardUrl?: string } = {}): DemoProjectResult {
  const stateDir = options.stateDir || process.env['OPENCODE_GATEWAY_STATE_DIR'] || path.join(process.env['HOME'] || process.cwd(), '.config', 'opencode-gateway')
  const artifactDir = path.join(stateDir, 'demo-artifacts')
  fs.mkdirSync(artifactDir, { recursive: true })
  const artifactPath = path.join(artifactDir, 'local-container-demo.log')
  fs.writeFileSync(artifactPath, ['Gateway demo run', 'No OpenCode Session was started.', 'No model tokens were spent.', 'This file demonstrates dashboard artifact links.'].join('\n') + '\n', { mode: 0o600 })

  const project = createProjectFromWizard({
    alias: 'demo',
    title: 'Gateway demo project',
    priority: 'LOW',
    sessionId: `ses_demo_${Date.now()}`,
    tasks: [
      { title: 'Inspect demo artifact links', description: 'Verify the dashboard exposes local-container log links without model spend.' },
      { title: 'Create your first real Gateway task', description: 'Replace the demo with real work after OpenCode readiness is understood.' },
    ],
    objective: 'Demonstrate Gateway durable state, dashboard explanations, and artifact links without calling a model.',
    acceptanceCriteria: ['Demo project appears in Mission Control.', 'At least one completed run has a redacted artifact link.', 'One pending task remains for the scheduler explanation panel.'],
    definitionOfDone: ['Operator can open the dashboard and inspect the demo run.', 'No external credentials or model calls are required.'],
    evidenceRequirements: ['Dashboard screenshot or local verification note.'],
    requiredArtifacts: ['local-container-demo.log'],
  })

  const firstTask = project.tasks[0]!
  const startedAt = new Date().toISOString()
  const started = startWorkTaskRun(firstTask.id, 'implement', 'ses_demo_completed', 'demo', undefined, {}, { environment: {
    id: `env_demo_${Date.now()}`,
    name: 'demo-local-container',
    backend: 'local-container',
    status: 'prepared',
    specHash: 'demo',
    workdir: artifactDir,
    runtime: 'docker',
    image: 'demo/no-runtime-required:latest',
    provider: 'local-container',
    startedAt,
    updatedAt: startedAt,
    ttlMs: 60 * 60 * 1000,
    cleanup: { retainOnFailure: true, retainOnSuccess: true, state: 'pending' },
    resources: { timeoutMs: 60 * 60 * 1000 },
    network: { mode: 'disabled' },
    secrets: { allowedNames: [] },
    preflight: { ok: true, checked: ['demo'], missing: [], warnings: ['demo mode does not start containers'], commandRefs: [] },
    artifacts: [`file:${artifactPath}`],
    metadata: { demoMode: true, commandCaptureDir: artifactDir },
  } })
  if (started) {
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'Demo artifact captured without model spend', artifacts: [`file:${artifactPath}`], evidence: [{ type: 'log', ref: `file:${artifactPath}`, summary: 'Demo local-container log link' }], decisions: ['Demo mode uses synthetic durable state only.'], raw: 'demo' }, 0)
  }

  appendWorkEvent('demo.created', project.roadmap.id, { artifact: `file:${artifactPath}` })
  return { ...project, artifactPath, dashboardUrl: options.dashboardUrl || dashboardUrl(getConfig()) }
}

export function explainWhyNotRunning(input: { tasks?: any[]; scheduler?: GatewayConfig['scheduler']; readiness?: any; heartbeat?: any; counts?: any } = {}): RunExplanation[] {
  const explanations: RunExplanation[] = []
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  const scheduler = input.scheduler
  const pending = tasks.filter(task => task.status === 'pending')
  const running = tasks.filter(task => task.status === 'running')
  const blocked = tasks.filter(task => task.status === 'blocked' || task.readiness?.status === 'blocked' || task.readiness?.status === 'waiting' || task.readiness?.status === 'paused' || task.readiness?.status === 'scheduled')

  if (input.readiness?.state === 'not_ready') {
    explanations.push({ severity: 'critical', title: 'Gateway is not ready', summary: input.readiness.summary || 'A critical readiness check failed.', actions: ['Open the Health tab or run `opencode-gateway readiness` for the failing check.'] })
  }
  if (scheduler && scheduler.enabled === false) {
    explanations.push({ severity: 'critical', title: 'Scheduler is paused', summary: 'Runnable tasks will not dispatch while the Gateway scheduler is disabled.', actions: ['Use gateway_scheduler_resume or POST /scheduler with action=resume.'] })
  }
  if (input.heartbeat?.status === 'error') {
    explanations.push({ severity: 'warning', title: 'Heartbeat is failing', summary: input.heartbeat.lastError || input.heartbeat.lastSummary || 'The last heartbeat reported an error.', actions: ['Inspect `/logs` and restart Gateway if the error persists.'] })
  }
  if (running.length) {
    explanations.push({ severity: 'info', title: 'Work is already running', summary: `${running.length} task${running.length === 1 ? '' : 's'} currently have active runs.`, actions: ['Open the Pipeline tab or Gateway session links for active run details.'] })
  }
  if (scheduler && running.length >= Number(scheduler.maxConcurrent || 0) && pending.length) {
    explanations.push({ severity: 'warning', title: 'Scheduler capacity is full', summary: `${running.length}/${scheduler.maxConcurrent} configured task stages are running. Pending tasks will wait for capacity.`, actions: ['Wait for a running stage to finish or raise scheduler.maxConcurrent if the machine can handle it.'] })
  }
  const runnable = pending.filter(task => !task.readiness || task.readiness.status === 'runnable')
  if (runnable.length && !running.length && scheduler?.enabled !== false) {
    explanations.push({ severity: 'info', title: 'Runnable work is waiting for the next scheduler tick', summary: `${runnable.length} pending task${runnable.length === 1 ? '' : 's'} are eligible to dispatch.`, actions: ['Wait for the next scheduler interval or run one scheduler cycle from MCP/HTTP.'], taskId: runnable[0].id })
  }
  if (blocked.length) {
    const first = blocked[0]
    explanations.push({ severity: first.status === 'blocked' ? 'critical' : 'warning', title: 'Some work is blocked or waiting', summary: first.readiness?.reason || first.note || `${blocked.length} task(s) cannot dispatch yet.`, actions: ['Open the task readiness details, resolve dependencies/gates, then retry or resume the task.'], taskId: first.id })
  }
  if (!pending.length && !running.length && !blocked.length) {
    explanations.push({ severity: 'info', title: 'No runnable durable work', summary: 'The queue has no pending, running, blocked, paused, or scheduled tasks.', actions: ['Create a task, run `opencode-gateway project new`, or try `opencode-gateway demo`.'] })
  }
  return dedupeExplanations(explanations).slice(0, 6)
}

export function artifactLinksForRefs(refs: unknown[], basePath = '/artifacts'): ArtifactLink[] {
  return [...new Set((refs || []).map(ref => String(ref || '').trim()).filter(Boolean))]
    .filter(ref => ref.startsWith('file:'))
    .map(ref => {
      const encoded = encodeURIComponent(ref)
      return { ref, label: artifactLabel(ref), url: `${basePath}?ref=${encoded}`, downloadUrl: `${basePath}?download=1&ref=${encoded}` }
    })
}

export function resolveArtifactContent(ref: string, state: WorkState = loadWorkState(), config: GatewayConfig = getConfig(), stateFilePath = workStatePath()): ArtifactContent {
  const normalized = String(ref || '').trim()
  if (!normalized.startsWith('file:')) throw new Error('Only file: artifact refs can be opened locally')
  // Resolve against the materialized state first (honours callers that pass an
  // explicit state), then fall back to a durable by-ref runs query so a ref
  // attached to an older run stays openable even if the live read is windowed.
  if (!knownArtifactRefs(state).has(normalized) && !runReferencesArtifact(normalized, stateFilePath)) throw new Error('Artifact ref is not attached to a known Gateway run')
  const filePath = path.resolve(normalized.replace(/^file:/, ''))
  const realPath = fs.realpathSync(filePath)
  const allowedRoots = artifactPreviewRoots()
  if (!isPathInsideAllowedRoot(realPath, allowedRoots)) {
    throw new Error('Artifact path is outside the Gateway preview roots')
  }
  const stat = fs.statSync(realPath)
  if (!stat.isFile()) throw new Error('Artifact ref does not point to a file')
  if (stat.size > 2 * 1024 * 1024) throw new Error('Artifact is larger than the 2 MiB inline view limit')
  const content = redactSensitiveText(fs.readFileSync(realPath, 'utf-8'), config)
  return { ref: normalized, path: realPath, filename: path.basename(realPath), contentType: contentTypeFor(realPath), content }
}

export function dashboardUrl(config: GatewayConfig = getConfig()): string {
  return `http://127.0.0.1:${config.httpPort}/dashboard#/overview`
}

function assertTemplateKind(kind: string): asserts kind is EnvironmentTemplateKind {
  if (!(ENVIRONMENT_TEMPLATE_KINDS as readonly string[]).includes(kind)) throw new Error(`template kind must be one of: ${ENVIRONMENT_TEMPLATE_KINDS.join(', ')}`)
}

function normalizeAlias(value: string): string {
  const text = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(text)) throw new Error('project alias must be 1-64 lowercase letters, numbers, underscores, or dashes and start with a letter or number')
  return text
}

function buildRoadmapQualitySpec(input: ProjectWizardInput & { title: string }): RoadmapQualitySpec {
  return {
    objective: input.objective || `Deliver ${input.title} with explicit acceptance evidence.`,
    acceptanceCriteria: nonEmptyList(input.acceptanceCriteria, [`${input.title} has clear tasks, evidence, and completion criteria.`]),
    definitionOfDone: nonEmptyList(input.definitionOfDone, ['All created tasks pass their Gateway pipeline or are explicitly accepted as residual risk.']),
    evidenceRequirements: nonEmptyList(input.evidenceRequirements, ['Each completed task includes at least one artifact or evidence entry.']),
    requiredArtifacts: nonEmptyList(input.requiredArtifacts, ['Gateway task run evidence.']),
    residualRiskNotes: input.residualRiskNotes || [],
    completionPolicy: 'assistant_proposes_user_approves',
  }
}

function normalizeWizardTasks(tasks: ProjectWizardInput['tasks'], priority: 'HIGH' | 'MEDIUM' | 'LOW', environment: ProjectWizardInput['environment'], agentTeam: string | undefined): Array<Record<string, unknown>> {
  const normalized = (tasks?.length ? tasks : ['Define acceptance criteria', 'Implement the first slice', 'Review and verify evidence']).map(task => {
    const row = typeof task === 'string' ? { title: task } : task
    const title = String(row.title || '').trim()
    if (!title) throw new Error('wizard task title cannot be empty')
    return {
      title,
      description: row.description || title,
      priority: row.priority || priority,
      pipeline: ['implement', 'review', 'verify'],
      environment,
      agentTeam,
      qualitySpec: {
        objective: title,
        constraints: [],
        acceptanceCriteria: [`Complete: ${title}`],
        definitionOfDone: ['Implementation, review, and verification stages have objective evidence.'],
        filesTouched: [],
        systemsTouched: [],
        requiredTools: [],
        verificationCommands: [],
        evidenceRequirements: ['Structured stage result with artifacts or evidence.'],
        requiredArtifacts: [],
      },
    }
  })
  return normalized
}

function projectWizardText(alias: string, roadmap: RoadmapRecord, tasks: WorkTaskRecord[]): string {
  return [`Project: ${alias}`, `Project record: ${roadmap.title} (${roadmap.id})`, `Issues: ${tasks.length}`, 'Next: open Mission Control or ask the Gateway supervisor for a review.'].join('\n')
}

function knownArtifactRefs(state: WorkState): Set<string> {
  const refs = new Set<string>()
  for (const run of state.runs || []) {
    for (const ref of run.environment?.artifacts || []) refs.add(String(ref))
    for (const ref of run.result?.artifacts || []) refs.add(String(ref))
    for (const evidence of run.result?.evidence || []) refs.add(String((evidence as StageEvidence).ref || ''))
  }
  refs.delete('')
  return refs
}

function artifactPreviewRoots(): string[] {
  return [storageStateDir()]
    .map(root => {
      try {
        return fs.realpathSync(root)
      } catch {
        return path.resolve(root)
      }
    })
}

function isPathInsideAllowedRoot(filePath: string, roots: string[]): boolean {
  const normalizedPath = path.resolve(filePath)
  return roots.some(root => {
    const normalizedRoot = path.resolve(root)
    const relative = path.relative(normalizedRoot, normalizedPath)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

function artifactLabel(ref: string): string {
  const filePath = ref.replace(/^file:/, '')
  return path.basename(filePath) || 'artifact'
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  if (filePath.endsWith('.md')) return 'text/markdown; charset=utf-8'
  return 'text/plain; charset=utf-8'
}

function nonEmptyList(values: string[] | undefined, fallback: string[]): string[] {
  const list = (values || []).map(value => String(value || '').trim()).filter(Boolean)
  return list.length ? list : fallback
}

function dedupeExplanations(rows: RunExplanation[]): RunExplanation[] {
  const seen = new Set<string>()
  return rows.filter(row => {
    const key = `${row.title}:${row.summary}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
