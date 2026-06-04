import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url))

function sourceFiles(dir = SRC_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (entry.isFile() && extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) return [path]
    return []
  })
}

function lineCount(path: string) {
  return readFileSync(path, 'utf8').split('\n').length
}

test('cloud web workbench production source stays split into bounded modules', () => {
  const files = new Map(sourceFiles().map((path) => [relative(SRC_ROOT, path), lineCount(path)]))
  const requiredModules = [
    'app-shell.ts',
    'branding.ts',
    'client-contract.ts',
    'client-script.ts',
    'client/admin-script.ts',
    'client/bindings-script.ts',
    'client/byok-script.ts',
    'client/common-script.ts',
    'client/data-script.ts',
    'client/gateway-script.ts',
    'client/ops-script.ts',
    'client/session-pagination-script.ts',
    'client/surfaces-script.ts',
    'client/workbench-script.ts',
    'html-utils.ts',
    'render.ts',
    'runtime-workbench.ts',
    'style-chat.ts',
    'style-components.ts',
    'style-layout.ts',
    'styles.ts',
    'surface-workbench.ts',
    'thread-workbench.ts',
    'workbench-parity.ts',
  ]
  for (const module of requiredModules) {
    assert.ok(files.has(module), `${module} exists`)
  }

  const explicitBudgets: Record<string, number> = {
    'render.ts': 800,
    'client-script.ts': 80,
    'client/admin-script.ts': 350,
    'client/bindings-script.ts': 180,
    'client/byok-script.ts': 160,
    'client/common-script.ts': 750,
    'client/data-script.ts': 500,
    'client/gateway-script.ts': 180,
    'client/ops-script.ts': 260,
    'client/surfaces-script.ts': 340,
    'client/workbench-script.ts': 1_100,
    'styles.ts': 700,
  }
  for (const [path, lines] of files) {
    const budget = explicitBudgets[path] || 600
    assert.ok(lines <= budget, `${path} has ${lines} lines; budget is ${budget}`)
  }
})

test('cloud web workbench does not import runtime, database, or provider-specific internals', () => {
  const forbidden = [
    /@opencode-ai\/sdk/,
    /postgres-control-plane-store/,
    /control-plane-store/,
    /node:sqlite/,
    /from ['"]pg['"]/,
    /stripe-billing-adapter/,
  ]
  for (const path of sourceFiles()) {
    const text = readFileSync(path, 'utf8')
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${relative(SRC_ROOT, path)} must stay a cloud HTTP client, not a runtime/store module`)
    }
  }
})
