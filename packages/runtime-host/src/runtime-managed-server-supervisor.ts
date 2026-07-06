// This module is forked as a standalone entrypoint — as compiled dist in
// production and as raw TypeScript source (via --experimental-strip-types) in
// tests. A relative './*.js' value specifier resolves against dist but not
// against the '.ts' source, so this runtime import must go through the package
// name, which resolves via the export map in both contexts. The type-only
// import below is erased by type-stripping, so it may use a relative specifier.
import { appendManagedOpencodeOutputTail, drainManagedOpencodeProcessOutput, parseManagedOpencodeServerStdoutChunk } from '@open-cowork/runtime-host'
import type { ManagedOpencodeServerParentMessage, ManagedOpencodeServerSupervisorMessage } from './runtime-managed-server-protocol.js'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
const currentModulePath = typeof __filename === 'string' && __filename !== '[eval]'
  ? __filename
  : import.meta.url

type ParentPortLike = {
  postMessage(message: ManagedOpencodeServerSupervisorMessage): void
  on(event: 'message', listener: (message: { data: unknown } | unknown) => void): unknown
}

function loadElectronParentPort() {
  try {
    const require = createRequire(currentModulePath)
    const electron = require('electron') as { parentPort?: ParentPortLike }
    return electron.parentPort
  } catch {
    return undefined
  }
}

const electronParentPort = loadElectronParentPort()
const processParentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort

function nodeParentPort(): ParentPortLike | null {
  if (typeof process.send !== 'function') return null
  return {
    postMessage(message) {
      process.send?.(message)
    },
    on(_event, listener) {
      process.on('message', (message) => listener({ data: message }))
    },
  }
}

const parentPort = processParentPort || electronParentPort || nodeParentPort()

let managedProcess: ChildProcess | null = null
let startupTimer: NodeJS.Timeout | null = null
let stdoutTail = ''
let startupSettled = false
let shuttingDown = false

function post(message: ManagedOpencodeServerSupervisorMessage) {
  parentPort?.postMessage(message)
}

function stopManagedOpencodeProcess(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32' && proc.pid) {
    const out = spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    if (!out.error && out.status === 0) return
  }
  proc.kill()
}

function clearStartupTimer() {
  if (!startupTimer) return
  clearTimeout(startupTimer)
  startupTimer = null
}

function settleStartup() {
  if (startupSettled) return false
  startupSettled = true
  clearStartupTimer()
  return true
}

function failStartup(message: string) {
  if (!settleStartup()) return
  post({ type: 'startup-error', message, stdoutTail })
  if (managedProcess) stopManagedOpencodeProcess(managedProcess)
}

function handleBoot(message: Extract<ManagedOpencodeServerParentMessage, { type: 'boot' }>) {
  if (managedProcess) {
    failStartup('Managed OpenCode server supervisor already has a running child process.')
    return
  }

  managedProcess = spawn(message.command, message.args, {
    env: message.env,
    cwd: message.cwd,
    windowsHide: true,
  })

  let stdoutBuffer = ''
  startupTimer = setTimeout(() => {
    failStartup(`Timeout waiting for server to start after ${message.timeoutMs}ms`)
  }, message.timeoutMs)

  managedProcess.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stdoutTail = appendManagedOpencodeOutputTail(stdoutTail, text)
    if (startupSettled) return
    const parsed = parseManagedOpencodeServerStdoutChunk(stdoutBuffer, text)
    stdoutBuffer = parsed.buffer
    if (parsed.error) {
      failStartup(parsed.error)
      return
    }
    if (parsed.url && managedProcess) {
      settleStartup()
      drainManagedOpencodeProcessOutput(managedProcess)
      post({ type: 'ready', url: parsed.url, pid: managedProcess.pid })
    }
  })

  managedProcess.stderr?.on('data', (chunk: Buffer) => {
    stdoutTail = appendManagedOpencodeOutputTail(stdoutTail, chunk.toString())
  })

  managedProcess.on('error', (error) => {
    if (!startupSettled) {
      failStartup(error.message)
      return
    }
    post({ type: 'exited', code: null, signal: null })
  })

  managedProcess.on('exit', (code, signal) => {
    clearStartupTimer()
    if (!startupSettled && !shuttingDown) {
      post({
        type: 'startup-error',
        message: `Server exited with code ${code}`,
        stdoutTail,
      })
      startupSettled = true
    }
    post({ type: 'exited', code, signal })
    managedProcess = null
  })
}

function handleShutdown() {
  shuttingDown = true
  clearStartupTimer()
  if (managedProcess) stopManagedOpencodeProcess(managedProcess)
}

parentPort?.on('message', (event) => {
  const data = event && typeof event === 'object' && 'data' in event
    ? (event as { data: unknown }).data
    : event
  const message = data as ManagedOpencodeServerParentMessage
  if (message.type === 'boot') handleBoot(message)
  else if (message.type === 'shutdown') handleShutdown()
})

setTimeout(() => {
  post({ type: 'supervisor-ready' })
}, 0)

process.once('disconnect', handleShutdown)
process.once('SIGTERM', () => {
  handleShutdown()
  process.exit(0)
})
