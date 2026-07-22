#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const scriptLog = (...args) => { process.stdout.write(args.map(String).join(' ') + String.fromCharCode(10)) }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const budgetPath = resolve(root, 'docs/development/god-module-loc-budgets.json')
const budget = JSON.parse(readFileSync(budgetPath, 'utf8'))
const failures = []
const results = []

for (const entry of budget.files || []) {
  const abs = resolve(root, entry.path)
  if (!existsSync(abs)) {
    failures.push(`missing ${entry.path}`)
    continue
  }
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/).length
  results.push({ path: entry.path, lines, maxLines: entry.maxLines })
  if (lines > entry.maxLines) {
    failures.push(`${entry.path} has ${lines} lines (max ${entry.maxLines})`)
  }
}

if (process.argv.includes('--json')) {
  scriptLog(JSON.stringify({ status: failures.length ? 'fail' : 'pass', results, failures }, null, 2))
} else {
  for (const r of results) {
    scriptLog(`${r.path}: ${r.lines}/${r.maxLines}`)
  }
  if (failures.length) {
    console.error('God-module LOC budget exceeded:\n' + failures.map((f) => `  - ${f}`).join('\n'))
    process.exit(1)
  }
  scriptLog('God-module LOC budgets OK')
}
