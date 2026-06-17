import test from 'node:test'
import assert from 'node:assert/strict'

import { getBrandName, getDocsBaseUrl, setBrandName, setDocsBaseUrl } from '../apps/desktop/src/renderer/helpers/brand.ts'

test('renderer brand singleton: docs base URL is configurable with a safe default + normalization', () => {
  // Default before any override is an absolute, slash-terminated base (the public app).
  const fallback = getDocsBaseUrl()
  assert.ok(fallback.startsWith('https://'))
  assert.ok(fallback.endsWith('/'))

  // A downstream builder can point docs at their own base (brand-agnostic).
  setDocsBaseUrl('https://docs.northwind.example')
  assert.equal(getDocsBaseUrl(), 'https://docs.northwind.example/')
  setDocsBaseUrl('https://docs.northwind.example/guide/')
  assert.equal(getDocsBaseUrl(), 'https://docs.northwind.example/guide/')

  // Empty / blank overrides are ignored (keep the last good value).
  setDocsBaseUrl('')
  setDocsBaseUrl(null)
  setDocsBaseUrl(undefined)
  assert.equal(getDocsBaseUrl(), 'https://docs.northwind.example/guide/')

  setBrandName('Northwind')
  assert.equal(getBrandName(), 'Northwind')
})
