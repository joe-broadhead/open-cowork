/**
 * Observability — full agent traceability for kaizen.
 *
 * Writes structured observability artifacts to the Gateway config directory.
 * Each artifact is append-only — like event sourcing.
 *
 * Artifacts:
 *   executions.jsonl  — one line per Gateway session completion (cost, tokens, pipeline stage, result)
 *   traces/            — full message trace dumps per Gateway session (optional, sampled)
 *   bottlenecks.md     — pipeline bottleneck analysis
 *   kaizen-tasks.md    — suggested improvements from blocked/failed tasks
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { getConfig, getConfigDir } from './config.js'
import { redactSensitiveText } from './security.js'

function observabilityDir(): string {
  return path.join(getConfigDir(), 'observability')
}

/**
 * Runtime usage fields the live OpenCode session exposes but the typed SDK
 * `Session` shape omits. All optional so a bare `Session` (or `{}`) is a valid
 * view without an `any` cast.
 */
interface SessionUsageView {
  agent?: string
  model?: { modelID?: string; providerID?: string }
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number } }
  time?: { created?: number }
}

export interface WorkerTrace {
  id: string
  title: string
  stage?: string
  agent: string
  model: string
  provider: string
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: number }
  status: 'completed' | 'failed' | 'blocked'
  startedAt: string
  completedAt: string
  retries: number
  lastMessage: string
}

export async function recordWorkerCompletion(client: OpencodeClient, workerInfo: {
  id: string; title: string; stage?: string; retries: number; status?: WorkerTrace['status']; summary?: string
}) {
  try {
    const { createOpenCodeSessionRuntime } = await import('./opencode-session-runtime.js')
    const runtime = createOpenCodeSessionRuntime(client)
    const got = await runtime.getSession(workerInfo.id).catch(() => ({ data: undefined, missing: true }))
    const msgList = await runtime.messages(workerInfo.id).catch(() => [] as any[])

    // The running OpenCode session carries usage fields (agent/model/cost/tokens)
    // that are absent from the typed Session shape; read them through a precise
    // optional view rather than erasing the whole object to `any`.
    const s: SessionUsageView = got?.data || {}

    let lastText = ''
    for (const p of (msgList[msgList.length - 1]?.parts || [])) {
      if (p.type === 'text') lastText += p.text + ' '
    }

    const trace: WorkerTrace = {
      id: workerInfo.id,
      title: workerInfo.title,
      stage: workerInfo.stage,
      agent: s.agent || 'unknown',
      model: s.model?.modelID || 'unknown',
      provider: s.model?.providerID || 'unknown',
      cost: s.cost || 0,
      tokens: {
        input: s.tokens?.input || 0,
        output: s.tokens?.output || 0,
        reasoning: s.tokens?.reasoning || 0,
        cache: s.tokens?.cache?.read || 0,
      },
      status: workerInfo.status || deriveStatusFromText(lastText),
      startedAt: new Date(s.time?.created || 0).toISOString(),
      completedAt: new Date().toISOString(),
      retries: workerInfo.retries,
      lastMessage: sanitizeTraceText(workerInfo.summary || lastText, 500),
    }

    // Append to JSONL
    const obsDir = observabilityDir()
    ensurePrivateDir(obsDir)
    appendPrivateFile(path.join(obsDir, 'executions.jsonl'), JSON.stringify(trace) + '\n')

    // Update bottleneck analysis
    await updateBottleneckAnalysis()

    // Check for kaizen suggestions
    if (trace.status === 'failed' || trace.status === 'blocked') {
      await updateKaizenTasks(trace)
    }

  } catch {}
}

function deriveStatusFromText(text: string): WorkerTrace['status'] {
  const upper = text.toUpperCase()
  if (upper.includes('FAIL')) return 'failed'
  if (upper.includes('BLOCK')) return 'blocked'
  return 'completed'
}

async function updateBottleneckAnalysis() {
  try {
    const obsDir = observabilityDir()
    const execFile = path.join(obsDir, 'executions.jsonl')
    if (!fs.existsSync(execFile)) return

    const lines = fs.readFileSync(execFile, 'utf-8').split('\n').filter(Boolean)
    const traces = lines.map(l => JSON.parse(l)) as WorkerTrace[]

    // Pipeline stage analysis
    const byStage = new Map<string, { total: number; failed: number; totalCost: number; totalTokens: number }>()
    for (const t of traces) {
      const key = t.stage || 'simple'
      const stats = byStage.get(key) || { total: 0, failed: 0, totalCost: 0, totalTokens: 0 }
      stats.total++
      if (t.status === 'failed' || t.status === 'blocked') stats.failed++
      stats.totalCost += t.cost
      stats.totalTokens += t.tokens.input + t.tokens.output + t.tokens.reasoning
      byStage.set(key, stats)
    }

    const bottlenecks = Array.from(byStage.entries())
      .sort((a, b) => b[1].failed - a[1].failed)

    writePrivateFile(path.join(obsDir, 'bottlenecks.md'), [
      '# Pipeline Bottleneck Analysis',
      '',
      `Updated: ${new Date().toISOString()}`,
      '',
      '| Stage | Total | Failed | Failure Rate | Cost | Tokens |',
      '|-------|-------|--------|-------------|------|--------|',
      ...bottlenecks.map(([s, d]) =>
        `| ${s} | ${d.total} | ${d.failed} | ${((d.failed/d.total)*100).toFixed(0)}% | $${d.totalCost.toFixed(4)} | ${d.totalTokens.toLocaleString()} |`
      ),
      '',
      `**Most blocking stage**: ${bottlenecks[0]?.[0] || 'N/A'} (${bottlenecks[0]?.[1].failed || 0} failures)`,
      (bottlenecks[0]?.[1].failed ?? 0) > 5 ? '**Action**: Consider improving agent instructions for this stage.' : '',
    ].join('\n'))

  } catch {}
}

async function updateKaizenTasks(trace: WorkerTrace) {
  try {
    const kaizenFile = path.join(observabilityDir(), 'kaizen-tasks.md')
    const header = fs.existsSync(kaizenFile) ? '' : '# Kaizen Improvement Tasks\n\nTasks auto-generated from failed or blocked Gateway stages. Review and promote them to durable Gateway tasks when useful.\n\n'

    appendPrivateFile(kaizenFile, [
      header ? header : '',
      `- [pending] MEDIUM: Improve ${trace.stage || 'stage'} agent — ${trace.title} failed after ${trace.retries} retries. Last: "${sanitizeTraceText(trace.lastMessage, 100)}..." (cost: $${trace.cost.toFixed(4)})`,
      '',
    ].filter(Boolean).join('\n'))

  } catch {}
}

function sanitizeTraceText(value: string, maxLength: number): string {
  let redacted: string
  try {
    redacted = redactSensitiveText(String(value || ''), getConfig())
  } catch {
    redacted = redactSensitiveText(String(value || ''))
  }
  return redacted.length <= maxLength ? redacted : redacted.substring(0, maxLength)
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch {}
}

function writePrivateFile(file: string, content: string): void {
  ensurePrivateDir(path.dirname(file))
  fs.writeFileSync(file, content, { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch {}
}

function appendPrivateFile(file: string, content: string): void {
  ensurePrivateDir(path.dirname(file))
  fs.appendFileSync(file, content, { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch {}
}
