import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

// Locks the Cloud Web client vendor-split pipeline in the DEFAULT gate (the real
// in-browser load is covered by the separate playwright e2e, which needs a
// browser and isn't in `pnpm test`). A split client white-screens if the cloud
// image ships only the entry and not the vendor/runtime chunks the entry imports
// — so the load-bearing invariant here is "build-cloud copies every chunk."
test('cloud React client vendor split: vite splits, build-cloud ships every chunk, SSR loads only the entry', () => {
  const vite = read('apps/website/vite.config.ts')
  assert.match(vite, /manualChunks/, 'vite must split a vendor chunk (not re-inline into one bundle)')
  assert.match(vite, /react\|react-dom\|scheduler/, 'react/react-dom/scheduler belong in the cacheable vendor chunk')
  assert.match(vite, /entryFileNames:\s*'open-cowork-cloud-react\.js'/, 'the entry keeps the fixed name the SSR shell references')

  const buildCloud = read('scripts/build-cloud.mjs')
  assert.match(buildCloud, /readdir\(clientDir\)/, 'build-cloud must enumerate the built client chunks')
  assert.match(buildCloud, /\.endsWith\('\.js'\)[\s\S]*copyFile/, 'build-cloud must copy every .js chunk into the cloud image')

  const render = read('apps/website/src/render.ts')
  assert.ok(render.includes('CLOUD_WEB_REACT_CLIENT_ASSET_PATH'), 'the SSR shell loads the entry chunk via the asset-path constant (the entry imports the rest)')

  const minify = read('scripts/minify-cloud-react-client.mjs')
  assert.match(minify, /readdir\(clientDir\)/, 'the size budget must sum all chunks, not just the entry')
})
