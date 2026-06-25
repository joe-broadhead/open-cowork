import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCloudWebStaticAsset } from '@open-cowork/cloud-server/web-static-assets'
import { getCloudWebReactClientAsset, isCloudWebReactClientAssetPath } from '@open-cowork/cloud-server/web-client-assets'

// Mirrors CLOUD_WEB_REACT_CLIENT_ASSET_PATH (apps/website react-client-asset.ts) and
// the vendor sibling vite emits (apps/website/vite.config.ts manualChunks).
const ENTRY = '/assets/open-cowork-cloud-react.js'
const VENDOR = '/assets/open-cowork-cloud-react-vendor.js'

// The entry chunk `import`s the vendor chunk by its fixed name, so a cloud server
// that serves ONLY the entry 404s the vendor chunk and white-screens the React app.
// `build-cloud` already ships every chunk; the serving layer must own them too. The
// browser e2e mocks these responses, so without this the resolver gap is untested.
test('cloud web resolver OWNS the entry and the vendor chunk route (regression: vendor 404)', () => {
  for (const pathname of [ENTRY, VENDOR]) {
    const res = resolveCloudWebStaticAsset(pathname)
    // null means "not my route" -> an unhandled 404. The resolver must return a
    // response object for the whole client chunk family, not just the entry.
    assert.notEqual(res, null, `resolver must own ${pathname} (returned null = unhandled 404)`)
    assert.ok(res && (res.status === 'ok' || res.status === 'not-found'))
    if (res && res.status === 'ok') {
      assert.match(res.contentType, /javascript/, `${pathname} must be served as javascript`)
    }
  }

  // When the client is built on disk (the canonical gate runs build:website via
  // test:prepare), the vendor chunk must actually serve, identically to the entry.
  const entry = resolveCloudWebStaticAsset(ENTRY)
  const vendor = resolveCloudWebStaticAsset(VENDOR)
  if (entry?.status === 'ok') {
    assert.equal(vendor?.status, 'ok', 'vendor chunk must serve whenever the entry does')
    if (vendor?.status === 'ok') assert.ok(vendor.body.length > 0, 'vendor chunk body must be non-empty')
  }
})

test('react client asset allowlist accepts the chunk family, rejects non-family + traversal', () => {
  for (const pathname of [
    ENTRY,
    VENDOR,
    '/assets/open-cowork-cloud-react-runtime.js',
    '/assets/open-cowork-cloud-react-react-vendor.js',
  ]) {
    assert.equal(isCloudWebReactClientAssetPath(pathname), true, `must accept ${pathname}`)
  }

  for (const pathname of [
    '/assets/evil.js',
    '/assets/open-cowork-cloud-react.css',
    '/assets/open-cowork-cloud-react-vendor.js.map',
    '/assets/open-cowork-cloud-react-.js', // empty variable segment
    '/assets/open-cowork-cloud-react-../secret.js',
    '/assets/open-cowork-cloud-react/../../etc/passwd',
    '/assets/../open-cowork-cloud-react.js',
    '/other/open-cowork-cloud-react.js',
  ]) {
    assert.equal(isCloudWebReactClientAssetPath(pathname), false, `must reject ${pathname}`)
    // A rejected path must never reach disk.
    assert.equal(getCloudWebReactClientAsset(pathname), null, `must not load ${pathname}`)
  }
})
