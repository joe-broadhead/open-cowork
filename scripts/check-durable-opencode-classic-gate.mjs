#!/usr/bin/env node
/**
 * JOE-941 pin gate: Durable Gateway OpenCode classic→V2 reopen controls.
 *
 * On OpenCode pin 1.18.1, Durable remains on classic root construction.
 * This script fails closed if:
 *  - construction invents client.v2 without burndown evidence, or
 *  - production session I/O scatters outside opencode-session-runtime.ts
 *    (façade is the single flip point when V2 is proven).
 *
 * Does NOT claim Durable is V2. Reopen full migration only after real-process
 * V2 probes (see docs/opencode-durable-gateway-classic-burndown.md).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// 1) Construction must stay classic root until JOE-941 migration lands.
const clientSrc = read(`products/gateway/src/${clientRel}`)
if (!clientSrc.includes("from '@opencode-ai/sdk'") && !clientSrc.includes('from "@opencode-ai/sdk"')) {
  failures.push(`${clientRel} must import classic root @opencode-ai/sdk (not /v2) until JOE-941 migration is proven`)
}
// Ignore comments: strip // and /* */ before checking for V2 construction.
const clientCode = clientSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
if (clientCode.includes('@opencode-ai/sdk/v2') || /\bclient\.v2\b/.test(clientCode)) {
  failures.push(`${clientRel} must not construct or call client.v2 on pin-gated classic path without burndown update`)
}
if (!clientSrc.includes('createOpencodeClient')) {
  failures.push(`${clientRel} must use createOpencodeClient (classic) until JOE-941 reopens`)
}

// 2) Session I/O must collapse onto the façade (single flip point for V2).
const residual = []
const sessionCall = /\b(?:client|c|sessionClient)\.session\.(?:get|list|abort|messages|prompt|create|delete)\b/
for (const file of listTsFiles(gatewaySrc)) {
  const rel = relative(gatewaySrc, file).replaceAll('\\', '/')
  if (rel === façadeRel) continue
  const text = readFileSync(file, 'utf8')
  if (sessionCall.test(text)) {
    residual.push(rel)
  }
}
if (residual.length > 0) {
  failures.push(
    `Residual classic client.session.* outside ${façadeRel} (migrate before expanding):\n` +
      residual.map((r) => `  - ${r}`).join('\n'),
  )
}

// 3) Façade itself must still call classic session shapes (no dual fiction).
const façade = read(`products/gateway/src/${façadeRel}`)
if (!sessionCall.test(façade)) {
  failures.push(`${façadeRel} must retain classic client.session.* until V2 methods are proven and migrated`)
}
const façadeCode = façade
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
if (/\bclient\.v2\b/.test(façadeCode) || façadeCode.includes('@opencode-ai/sdk/v2')) {
  failures.push(`${façadeRel} must not use client.v2 until JOE-941 pin reopen with probe evidence`)
}

// 4) Burndown doc still documents classic status.
const burndown = read('docs/opencode-durable-gateway-classic-burndown.md')
if (!burndown.includes('JOE-941')) {
  failures.push('docs/opencode-durable-gateway-classic-burndown.md must reference JOE-941')
}
if (!burndown.includes('classic root') && !burndown.includes('classic root entry')) {
  failures.push('durable classic burndown must still document classic root construction')
}

if (failures.length) {
  console.error('Durable OpenCode classic gate (JOE-941):\n' + failures.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
console.log('Durable OpenCode classic gate OK (façade-only classic session I/O; V2 migration still pin-gated)')
