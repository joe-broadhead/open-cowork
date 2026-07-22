#!/usr/bin/env node
/**
 * JOE-941 gate: Durable Gateway OpenCode client construction + session façade.
 *
 * After V2 migration: construction uses `@opencode-ai/sdk/v2` and session I/O
 * prefers `client.v2.session.*` inside opencode-session-runtime.ts (classic
 * session.* fallback allowed for partial mocks only, still in the façade).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const scriptLog = (...args) => { process.stdout.write(args.map(String).join(' ') + String.fromCharCode(10)) }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const gatewaySrc = join(root, 'products/gateway/src')
const façadeRel = 'opencode-session-runtime.ts'
const clientRel = 'opencode-client.ts'
const failures = []

function read(rel) {
  return readFileSync(join(root, rel), 'utf8')
}

function listTsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
      out.push(...listTsFiles(full))
      continue
    }
    if (!name.endsWith('.ts')) continue
    if (name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue
    out.push(full)
  }
  return out
}

const clientSrc = read(`products/gateway/src/${clientRel}`)
if (!clientSrc.includes("@opencode-ai/sdk/v2") && !clientSrc.includes('@opencode-ai/sdk/v2')) {
  failures.push(`${clientRel} must construct from @opencode-ai/sdk/v2 (JOE-941)`)
}
if (!clientSrc.includes('createOpencodeClient')) {
  failures.push(`${clientRel} must use createOpencodeClient`)
}

const residual = []
const sessionCall = /\b(?:client|c|sessionClient)\.session\.(?:get|list|abort|messages|prompt|create|delete)\b/
for (const file of listTsFiles(gatewaySrc)) {
  const rel = relative(gatewaySrc, file).replaceAll('\\', '/')
  if (rel === façadeRel) continue
  const text = readFileSync(file, 'utf8')
  if (sessionCall.test(text)) residual.push(rel)
}
if (residual.length > 0) {
  failures.push(
    `Residual classic client.session.* outside ${façadeRel}:\n` + residual.map((r) => `  - ${r}`).join('\n'),
  )
}

const façade = read(`products/gateway/src/${façadeRel}`)
if (!façade.includes('v2.session') && !façade.includes('v2Session') && !façade.includes('client.v2')) {
  failures.push(`${façadeRel} must prefer V2 session APIs (JOE-941)`)
}

const burndown = read('docs/opencode-durable-gateway-classic-burndown.md')
if (!burndown.includes('JOE-941')) {
  failures.push('docs/opencode-durable-gateway-classic-burndown.md must reference JOE-941')
}

if (failures.length) {
  console.error('Durable OpenCode V2 gate (JOE-941):\n' + failures.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
scriptLog('Durable OpenCode V2 gate OK (V2 construction + façade-only session I/O)')
