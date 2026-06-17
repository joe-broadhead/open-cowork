import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { brandingAssetUrl, resolveAppIconFile, resolveBrandingAssetFile } from '../apps/desktop/src/main/branding-assets.ts'

function tempBrandingRoot() {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-branding-'))
  writeFileSync(join(root, 'acme-logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" />')
  return root
}

test('branding asset paths resolve inside the bundled branding root', () => {
  const root = tempBrandingRoot()
  const expected = realpathSync.native(join(root, 'acme-logo.svg'))
  assert.equal(resolveBrandingAssetFile('acme-logo.svg', root), expected)
  assert.equal(resolveBrandingAssetFile('branding/acme-logo.svg', root), expected)
  assert.equal(brandingAssetUrl('acme-logo.svg', root), 'open-cowork-asset://branding/acme-logo.svg')
  assert.equal(brandingAssetUrl('branding/acme-logo.svg', root), 'open-cowork-asset://branding/acme-logo.svg')
})

test('app icon resolves a configured branding-relative png and rejects invalid inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-icon-'))
  writeFileSync(join(root, 'app-icon.png'), 'png')
  writeFileSync(join(root, 'app-icon.icns'), 'icns')
  const expected = realpathSync.native(join(root, 'app-icon.png'))

  assert.equal(resolveAppIconFile('app-icon.png', root), expected)
  // Unset → null so the window/dock fall back to the bundled default icon.
  assert.equal(resolveAppIconFile(undefined, root), null)
  assert.equal(resolveAppIconFile('', root), null)
  assert.equal(resolveAppIconFile(null, root), null)
  // Traversal, missing files, and unsupported icon types are rejected (.icns is build-time only).
  assert.equal(resolveAppIconFile('../app-icon.png', root), null)
  assert.equal(resolveAppIconFile('missing.png', root), null)
  assert.equal(resolveAppIconFile('app-icon.icns', root), null)
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

test('branding asset paths reject symlink escapes from the branding root', () => {
  const root = tempBrandingRoot()
  const outsideRoot = mkdtempSync(join(tmpdir(), 'open-cowork-branding-outside-'))
  try {
    const outsideAsset = join(outsideRoot, 'outside.svg')
    writeFileSync(outsideAsset, '<svg xmlns="http://www.w3.org/2000/svg" />')
    symlinkSync(outsideAsset, join(root, 'linked-logo.svg'))

    assert.equal(resolveBrandingAssetFile('linked-logo.svg', root), null)
    assert.equal(brandingAssetUrl('linked-logo.svg', root), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outsideRoot, { recursive: true, force: true })
  }
})
