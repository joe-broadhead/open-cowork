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
    if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name)) && !/\.test\.tsx?$/.test(entry.name)) return [path]
    return []
  })
}

function lineCount(path: string) {
  return readFileSync(path, 'utf8').split('\n').length
}

test('cloud web workbench production source stays split into bounded modules', () => {
  const files = new Map(sourceFiles().map((path) => [relative(SRC_ROOT, path), lineCount(path)]))
  const requiredModules = [
    'admin-surface-matrix.ts',
    'app-api.ts',
    'app-shell.ts',
    'branding.ts',
    'client-contract.ts',
    'cloud-theme-client.ts',
    'cloud-theme.ts',
    'html-utils.ts',
    'react-admin-surfaces.tsx',
    'react-client-asset.ts',
    'react-client.tsx',
    'react-project-source.ts',
    'react-shell.ts',
    'react-shell-controller.tsx',
    'react-state.ts',
    'react-workbench-app.tsx',
    'react-workbench-controller.ts',
    'react-workbench-forms.ts',
    'react-workbench-hooks.ts',
    'react-workbench-review.tsx',
    'react-workbench-surfaces.tsx',
    'react-workbench.ts',
    'render.ts',
    'route-markup.ts',
    'runtime-workbench.ts',
    'style-chat.ts',
    'style-components.ts',
    'style-layout.ts',
    'style-shared-ui.ts',
    'styles.ts',
    'surface-workbench.ts',
    'thread-workbench.ts',
    'workbench-parity.ts',
  ]
  for (const module of requiredModules) {
    assert.ok(files.has(module), `${module} exists`)
  }

  const explicitBudgets: Record<string, number> = {
    'browser-test-harness.ts': 650,
    'render.ts': 800,
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
