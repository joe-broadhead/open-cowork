import test from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml } from '../apps/desktop/src/main/html-escape.ts'

test('escapeHtml escapes HTML-sensitive characters in main-process responses', () => {
  assert.equal(
    escapeHtml(`Signed in as <alice@example.com> & "Open Cowork's" user`),
    'Signed in as &lt;alice@example.com&gt; &amp; &quot;Open Cowork&#39;s&quot; user',
  )
})

test('escapeHtml stringifies non-string values before escaping', () => {
  assert.equal(escapeHtml(null), 'null')
  assert.equal(escapeHtml(42), '42')
})
