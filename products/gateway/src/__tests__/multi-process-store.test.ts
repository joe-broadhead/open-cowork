import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { listWorkEventsByType, loadWorkState } from '../work-store.js'

/**
 * Cross-process durability: everywhere else in the suite, concurrency runs
 * inside one Node event loop. These tests spawn real child Node processes
 * (node --import tsx, the same pattern the CLI tests use) contending on the
 * SAME gateway.db, so actual WAL locking, BEGIN IMMEDIATE serialization, and
 * PRAGMA busy_timeout retry behavior are observed across OS process
 * boundaries — plus writer/standby leadership between two live processes.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const contenderScript = path.join(projectRoot, 'src', '__tests__', 'helpers', 'store-contender.ts')
const leadershipScript = path.join(projectRoot, 'src', '__tests__', 'helpers', 'leadership-holder.ts')

interface ChildResult {
  status: number | null
  stdout: string
  stderr: string
}

describe.sequential('multi-process SQLite store contention', () => {
  let testDir = ''
  let store = ''
  const children: ChildProcess[] = []

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-multi-process-'))
    store = path.join(testDir, 'gateway.db')
    // Initialize the schema once from the parent so the children contend on
    // row mutations, not first-boot DDL.
    loadWorkState(store)
  })

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch {}
      }
    }
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  function spawnHelper(script: string, args: string[]): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OPENCODE_GATEWAY_CONFIG_DIR: testDir,
        OPENCODE_GATEWAY_STATE_DIR: testDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    return child
  }

  function collectOutput(child: ChildProcess): { stdout: () => string; stderr: () => string } {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    return { stdout: () => stdout, stderr: () => stderr }
  }

  function waitForExit(child: ChildProcess, output: ReturnType<typeof collectOutput>, deadlineMs = 60_000): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        reject(new Error(`child did not exit within ${deadlineMs}ms; stderr: ${output.stderr()}`))
      }, deadlineMs)
      child.on('close', code => {
        clearTimeout(timer)
        resolve({ status: code, stdout: output.stdout(), stderr: output.stderr() })
      })
      child.on('error', err => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  function waitForJsonLine(child: ChildProcess, output: ReturnType<typeof collectOutput>, deadlineMs = 60_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no output line within ${deadlineMs}ms; stderr: ${output.stderr()}`)), deadlineMs)
      const check = () => {
        const line = output.stdout().split('\n').find(candidate => candidate.trim().startsWith('{'))
        if (!line) return
        clearTimeout(timer)
        child.stdout?.off('data', check)
        resolve(JSON.parse(line))
      }
      child.stdout?.on('data', check)
      child.on('close', () => {
        clearTimeout(timer)
        check()
        reject(new Error(`child exited before printing a line; stderr: ${output.stderr()}`))
      })
    })
  }

  function parseReport(result: ChildResult): { workerId: string; created: string[] } {
    const line = result.stdout.split('\n').find(candidate => candidate.trim().startsWith('{'))
    expect(line, `helper stdout missing JSON report; stderr: ${result.stderr}`).toBeDefined()
    return JSON.parse(line!)
  }

  it('lands every mutateWorkState write from two OS processes hammering one store', async () => {
    const alpha = spawnHelper(contenderScript, ['alpha', '25'])
    const beta = spawnHelper(contenderScript, ['beta', '25'])
    const alphaOutput = collectOutput(alpha)
    const betaOutput = collectOutput(beta)

    const [alphaResult, betaResult] = await Promise.all([
      waitForExit(alpha, alphaOutput),
      waitForExit(beta, betaOutput),
    ])

    // Busy/locked errors inside a child abort it with a non-zero exit.
    expect(alphaResult.status, `alpha stderr: ${alphaResult.stderr}`).toBe(0)
    expect(betaResult.status, `beta stderr: ${betaResult.stderr}`).toBe(0)

    const reported = [...parseReport(alphaResult).created, ...parseReport(betaResult).created]
    expect(reported).toHaveLength(50)
    expect(new Set(reported).size).toBe(50)

    // Every write landed: 50 tasks, ids exactly matching what children reported.
    const state = loadWorkState(store)
    const contended = state.tasks.filter(task => task.title.startsWith('contend-'))
    expect(contended).toHaveLength(50)
    expect(new Set(contended.map(task => task.id))).toEqual(new Set(reported))
    // Each task finished pause -> resume; a dropped WAL-busy write would leave 'paused'.
    expect(contended.filter(task => task.status === 'pending')).toHaveLength(50)

    // Durable event trail is consistent: one task.created event per reported task.
    const createdEvents = listWorkEventsByType('task.created', 1000, store)
    const reportedSet = new Set(reported)
    expect(createdEvents.filter(event => reportedSet.has(String(event.subjectId)))).toHaveLength(50)

    // No corruption after cross-process WAL contention.
    const db = new DatabaseSync(store)
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get() as any
      expect(integrity.integrity_check).toBe('ok')
    } finally {
      db.close()
    }
  }, 120_000)

  it('keeps a second daemon process standby while a live writer process holds the lease', async () => {
    const holder = spawnHelper(leadershipScript, ['daemon-a', 'hold'])
    const holderOutput = collectOutput(holder)

    const writerSnapshot = await waitForJsonLine(holder, holderOutput)
    expect(writerSnapshot).toMatchObject({ mode: 'writer', canWrite: true })
    expect(String(writerSnapshot.leaderId)).toContain('daemon-a')

    // Second real process must come up standby against the held lease.
    const standby = spawnHelper(leadershipScript, ['daemon-b'])
    const standbyOutput = collectOutput(standby)
    const standbyResult = await waitForExit(standby, standbyOutput)
    expect(standbyResult.status, `standby stderr: ${standbyResult.stderr}`).toBe(0)
    const standbySnapshot = parseReport(standbyResult) as any
    expect(standbySnapshot).toMatchObject({ mode: 'standby', canWrite: false })
    expect(String(standbySnapshot.leaderId)).toContain('daemon-a')

    // Parent closes stdin; the holder releases the lease and exits cleanly.
    holder.stdin?.end()
    const holderResult = await waitForExit(holder, holderOutput)
    expect(holderResult.status, `holder stderr: ${holderResult.stderr}`).toBe(0)
  }, 120_000)
})
