import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { brandingAssetUrl, resolveBrandingAssetFile } from '../apps/desktop/src/main/branding-assets.ts'

function tempBrandingRoot() {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-branding-'))
  writeFileSync(join(root, 'acme-logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" />')
  return root
}

test('branding asset paths resolve inside the bundled branding root', () => {
  const root = tempBrandingRoot()
  assert.equal(resolveBrandingAssetFile('acme-logo.svg', root), join(root, 'acme-logo.svg'))
  assert.equal(resolveBrandingAssetFile('branding/acme-logo.svg', root), join(root, 'acme-logo.svg'))
  assert.equal(brandingAssetUrl('acme-logo.svg', root), 'open-cowork-asset://branding/acme-logo.svg')
  assert.equal(brandingAssetUrl('branding/acme-logo.svg', root), 'open-cowork-asset://branding/acme-logo.svg')
})

test('branding asset paths reject traversal, absolute paths, URLs, missing files, and unsupported extensions', () => {
  const root = tempBrandingRoot()
  for (const assetPath of [
    '../acme-logo.svg',
    '/tmp/acme-logo.svg',
    'https://cdn.example.test/acme-logo.svg',
    'acme-logo.html',
    'missing-logo.svg',
  ]) {
    assert.equal(resolveBrandingAssetFile(assetPath, root), null)
    assert.equal(brandingAssetUrl(assetPath, root), undefined)
  }
})
