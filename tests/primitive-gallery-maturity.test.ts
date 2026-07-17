import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const gallery = readFileSync(
  join(process.cwd(), 'packages/ui/src/PrimitiveGallery.tsx'),
  'utf8',
)

test('PrimitiveGallery labels experimental Studio sections (JOE-887)', () => {
  assert.match(gallery, /maturity = 'production'/)
  assert.match(gallery, /maturity\?: 'production' \| 'experimental'/)
  assert.match(gallery, /data-gallery-maturity=\{maturity\}/)
  assert.match(
    gallery,
    /Studio Shell And Coworking Primitives" maturity="experimental"/,
  )
  assert.match(gallery, /Sections marked <strong>Production<\/strong>/)
  assert.match(gallery, /Sections marked <strong>Experimental<\/strong>/)
})

test('design-system docs document gallery maturity honesty', () => {
  const doc = readFileSync(join(process.cwd(), 'docs/design-system.md'), 'utf8')
  assert.match(doc, /data-gallery-maturity/)
  assert.match(doc, /experimental/)
})
