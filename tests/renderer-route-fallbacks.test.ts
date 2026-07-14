import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

test('lazy renderer routes always render visible fallback UI', () => {
  const routeSources = [
    'packages/app/src/App.tsx',
    'packages/app/src/components/layout/AppRoutes.tsx',
  ].map((path) => readFileSync(join(repoRoot, path), 'utf8'))
  const routeFallback = readFileSync(join(repoRoot, 'packages/app/src/components/layout/RouteFallback.tsx'), 'utf8')
  const suspenseCount = routeSources.reduce((count, source) => count + (source.match(/<Suspense\b/g)?.length ?? 0), 0)
  const visibleFallbackCount = routeSources.reduce(
    (count, source) => count + (source.match(/<Suspense\s+fallback=\{<(?:RouteFallback|PaletteFallback)\b/g)?.length ?? 0),
    0,
  )

  assert.equal(suspenseCount > 0, true)
  assert.equal(visibleFallbackCount, suspenseCount)
  for (const source of routeSources) assert.doesNotMatch(source, /fallback=\{null\}/)
  assert.match(routeFallback, /role="status"/)
  assert.match(routeFallback, /aria-live="polite"/)
})

test('sidebar approval badge uses the cheap queue count path', () => {
  const sidebar = readFileSync(join(repoRoot, 'packages/app/src/components/layout/Sidebar.tsx'), 'utf8')

  assert.match(sidebar, /countDesktopApprovalQueueItems/)
  assert.doesNotMatch(sidebar, /buildDesktopApprovalQueueItems/)
})
